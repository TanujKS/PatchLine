/**
 * R2 storage helpers.
 *
 * - putRaw / putAttachment: write via R2 binding (no creds needed)
 * - presignGet:             generate a presigned download URL via S3 API
 *                           (needed because R2 binding does not produce signed URLs)
 *
 * All object key conventions live here so they cannot drift across call sites.
 */

import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Key builders - the only place that knows about R2 layout
// ---------------------------------------------------------------------------

export const keys = {
  rawEmail: (request_id: string) => `inbound/${request_id}/raw.eml`,
  attachment: (request_id: string, filename: string) =>
    `inbound/${request_id}/attachments/${sanitizeFilename(filename)}`,
};

/**
 * Strips path components and characters that could confuse R2 keys or
 * downstream consumers (Slack/GitHub markdown, terminal copy-paste).
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.slice(0, 200) || 'file';
}

// ---------------------------------------------------------------------------
// Writes via binding
// ---------------------------------------------------------------------------

export async function putRawEmail(
  env: Env,
  request_id: string,
  raw: ReadableStream | ArrayBuffer | Uint8Array,
): Promise<string> {
  const key = keys.rawEmail(request_id);
  await env.patchline_storage.put(key, raw, {
    httpMetadata: { contentType: 'message/rfc822' },
  });
  return key;
}

export async function putAttachment(
  env: Env,
  request_id: string,
  filename: string,
  body: ArrayBuffer | Uint8Array,
  mime?: string,
): Promise<string> {
  const key = keys.attachment(request_id, filename);
  await env.patchline_storage.put(key, body, {
    httpMetadata: mime ? { contentType: mime } : undefined,
  });
  return key;
}

// ---------------------------------------------------------------------------
// Presigned GET for issue-body links
// ---------------------------------------------------------------------------

let cachedClient: { creds: string; client: AwsClient } | null = null;

function getAwsClient(env: Env): AwsClient {
  const creds = `${env.R2_S3_ACCESS_KEY_ID}:${env.R2_S3_SECRET_ACCESS_KEY}`;
  if (cachedClient && cachedClient.creds === creds) return cachedClient.client;
  const client = new AwsClient({
    accessKeyId: env.R2_S3_ACCESS_KEY_ID,
    secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  cachedClient = { creds, client };
  return client;
}

/**
 * Returns a presigned GET URL valid for `PRESIGN_EXPIRY_SECONDS` (default 7d).
 *
 * Uses the R2 S3-compatible endpoint:
 *   https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key>
 */
export async function presignGet(env: Env, key: string): Promise<string> {
  const expires = Number(env.PRESIGN_EXPIRY_SECONDS) || 604800;
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${encodeURI(key)}`;
  const url = new URL(endpoint);
  url.searchParams.set('X-Amz-Expires', String(expires));

  const client = getAwsClient(env);
  const signed = await client.sign(
    new Request(url.toString(), { method: 'GET' }),
    { aws: { signQuery: true } },
  );
  return signed.url;
}
