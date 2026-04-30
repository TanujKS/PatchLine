/**
 * GitHub App auth using Web Crypto - no Node dependencies, runs in Workers.
 *
 * Flow:
 *   1. Sign a 10-minute JWT with the App private key (RS256).
 *   2. POST /app/installations/{id}/access_tokens to get an installation token (~1h).
 *   3. Cache the installation token in-memory until ~5 min before expiry.
 *
 * The JWT itself is also cached briefly to avoid signing on every request.
 *
 * Token cache scope: per-isolate. That is fine - each isolate independently
 * holds a valid token, and GitHub's per-installation token rate limit is
 * 5,000 req/hour which we will not approach.
 */

import type { Env } from '../types';

interface CachedInstallationToken {
  token: string;
  expires_at: number; // epoch ms
}

const installationTokenCache = new Map<number, CachedInstallationToken>();
let cachedJwt: { jwt: string; expires_at: number } | null = null;
let cachedKey: { pem: string; key: CryptoKey } | null = null;

const JWT_LIFETIME_MS = 9 * 60 * 1000;            // 9 minutes (GitHub max is 10)
const TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;    // refresh 5 min before expiry

/**
 * Returns a valid installation token, minting (and caching) one if needed.
 */
export async function getInstallationToken(
  env: Env,
  installation_id: number,
): Promise<string> {
  const now = Date.now();
  const cached = installationTokenCache.get(installation_id);
  if (cached && cached.expires_at - TOKEN_REFRESH_LEEWAY_MS > now) {
    return cached.token;
  }

  const jwt = await getAppJwt(env);
  const res = await fetch(
    `https://api.github.com/app/installations/${installation_id}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'patchline-worker',
      },
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GithubAuthError(
      `installation_token mint failed: ${res.status} ${res.statusText} - ${text}`,
    );
  }

  const body = (await res.json()) as { token: string; expires_at: string };
  const entry: CachedInstallationToken = {
    token: body.token,
    expires_at: Date.parse(body.expires_at),
  };
  installationTokenCache.set(installation_id, entry);
  return entry.token;
}

/**
 * Returns a valid app-level JWT, minting one if needed.
 * Used internally for installation token mint, and externally if a caller
 * needs to hit /app endpoints (rare in v1).
 */
export async function getAppJwt(env: Env): Promise<string> {
  const now = Date.now();
  if (cachedJwt && cachedJwt.expires_at - 30_000 > now) return cachedJwt.jwt;

  const key = await loadPrivateKey(env.GITHUB_APP_PRIVATE_KEY);

  // GitHub recommends iat 60s in the past to tolerate clock skew.
  const iat = Math.floor(now / 1000) - 60;
  const exp = Math.floor((now + JWT_LIFETIME_MS) / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat, exp, iss: env.GITHUB_APP_ID };

  const headerB64 = base64UrlEncodeJson(header);
  const payloadB64 = base64UrlEncodeJson(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(signingInput),
  );
  const sigB64 = base64UrlEncode(new Uint8Array(sig));

  const jwt = `${signingInput}.${sigB64}`;
  cachedJwt = { jwt, expires_at: now + JWT_LIFETIME_MS };
  return jwt;
}

// ---------------------------------------------------------------------------
// PEM -> CryptoKey
// ---------------------------------------------------------------------------

async function loadPrivateKey(pem: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.pem === pem) return cachedKey.key;

  const der = pemToDer(pem);
  // GitHub Apps issue PKCS#1 keys (RSA PRIVATE KEY) by default.
  // Web Crypto only accepts PKCS#8, so convert if needed.
  const pkcs8 = pem.includes('BEGIN RSA PRIVATE KEY')
    ? pkcs1ToPkcs8(der)
    : der;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKey = { pem, key };
  return key;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Wraps a PKCS#1 RSAPrivateKey in the PKCS#8 PrivateKeyInfo structure
 * Web Crypto requires. Adds the fixed RSA-OID prefix.
 *
 * Spec: RFC 5208 + RFC 8017.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // PrivateKeyInfo ::= SEQUENCE {
  //   version Integer (0),
  //   privateKeyAlgorithm AlgorithmIdentifier,    -- rsaEncryption + NULL
  //   privateKey OCTET STRING                     -- contains the PKCS#1 blob
  // }
  const rsaOid = new Uint8Array([
    0x30, 0x0d,                                     // SEQUENCE (13 bytes)
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, // OID 1.2.840.113549.1.1.1
    0x01, 0x01, 0x01,
    0x05, 0x00,                                     // NULL
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
  const octetStringHeader = derLengthHeader(0x04, pkcs1.length);
  const octetString = concatBytes(octetStringHeader, pkcs1);
  const inner = concatBytes(version, rsaOid, octetString);
  const outer = concatBytes(derLengthHeader(0x30, inner.length), inner);
  return outer;
}

function derLengthHeader(tag: number, len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([tag, len]);
  if (len < 0x100) return new Uint8Array([tag, 0x81, len]);
  if (len < 0x10000) return new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  return new Uint8Array([
    tag, 0x83,
    (len >> 16) & 0xff,
    (len >> 8) & 0xff,
    len & 0xff,
  ]);
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GithubAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GithubAuthError';
  }
}
