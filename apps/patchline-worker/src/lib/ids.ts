/**
 * ULID generator (Crockford base32, monotonic per call).
 *
 * Uses Web Crypto for randomness. Compatible with Workers runtime.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number): string {
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    out = ENCODING[mod] + out;
    now = (now - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(): string {
  const buf = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[buf[i] % ENCODING_LEN];
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** Domain-prefixed ids for readability in D1 + audit logs. */
export const newRequestId = () => `req_${ulid()}`;
export const newAttachmentId = () => `att_${ulid()}`;
export const newChangeRequestId = () => `chg_${ulid()}`;
export const newIssueRowId = () => `iss_${ulid()}`;
export const newPrRowId = () => `pr_${ulid()}`;
export const newAuditId = () => `aud_${ulid()}`;
