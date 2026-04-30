/**
 * Admin notifications via Cloudflare's send_email binding.
 *
 * Used by:
 *   - the DLQ consumer (terminal failures after queue retries)
 *   - the email() handler's pre-persist safety net
 *
 * Single helper, single MIME formatter, single debounce policy. DRY.
 *
 * Constraint: env.SEND_EMAIL only delivers to addresses verified as
 * "Destination Addresses" in Cloudflare Email Routing. ADMIN_NOTIFY_EMAIL
 * must be one of those (not a routing address - the actual mailbox).
 */

import { EmailMessage } from 'cloudflare:email';
import { audit, hasRecentFingerprint } from '../db/audit';
import type { Env } from '../types';
import { log } from './logger';

const DEBOUNCE_WINDOW_MS = 10 * 60 * 1000;

export interface NotifyInput {
  /** Categorical key for debounce: e.g. "github_auth", "d1_outage", "normalizer_bug". */
  errorClass: string;
  /** Optional - included in subject and audit. */
  request_id?: string;
  /** Optional - included in subject and audit. */
  site_slug?: string;
  /** Short, human-readable summary line. */
  subject: string;
  /** Full plain-text body. Will be wrapped in a minimal MIME envelope. */
  body: string;
  /** If you want extra structured detail in the audit trail. */
  detail?: unknown;
}

/**
 * Sends a notification email if not debounced. Always audits the attempt.
 * Returns true if an email was actually sent.
 *
 * Never throws - notification failures must not cascade and disrupt the
 * primary failure-handling path.
 */
export async function notify(env: Env, input: NotifyInput): Promise<boolean> {
  const fingerprint = `${input.errorClass}|${input.site_slug ?? '-'}`;

  try {
    const debounced = await hasRecentFingerprint(env.patchline_db, fingerprint, DEBOUNCE_WINDOW_MS);
    if (debounced) {
      await audit(env.patchline_db, {
        request_id: input.request_id ?? null,
        actor: 'system',
        event: 'notify_debounced',
        fingerprint,
        detail: { errorClass: input.errorClass, subject: input.subject },
      });
      log.info('notify debounced', { event: 'notify_debounced', fingerprint, request_id: input.request_id });
      return false;
    }

    const subject = `[patchline] ${input.subject}`;
    const mime = buildMime({
      from: env.NOTIFY_FROM_EMAIL,
      to: env.ADMIN_NOTIFY_EMAIL,
      subject,
      body: input.body,
    });

    const msg = new EmailMessage(env.NOTIFY_FROM_EMAIL, env.ADMIN_NOTIFY_EMAIL, mime);
    await env.SEND_EMAIL.send(msg);

    await audit(env.patchline_db, {
      request_id: input.request_id ?? null,
      actor: 'system',
      event: 'notify_sent',
      fingerprint,
      detail: { errorClass: input.errorClass, subject, to: env.ADMIN_NOTIFY_EMAIL },
    });
    log.info('notify sent', { event: 'notify_sent', fingerprint, request_id: input.request_id });
    return true;
  } catch (e) {
    log.error('notify failed', { event: 'notify_failed', fingerprint, request_id: input.request_id }, e);
    try {
      await audit(env.patchline_db, {
        request_id: input.request_id ?? null,
        actor: 'system',
        event: 'notify_failed',
        fingerprint,
        detail: { errorClass: input.errorClass, message: errMessage(e) },
      });
    } catch {
      // last-ditch: even audit failed, just swallow.
    }
    return false;
  }
}

/**
 * Convenience wrapper for DLQ failures - normalizes the body format so every
 * DLQ email looks the same.
 */
export async function notifyDlqFailure(
  env: Env,
  args: {
    request_id: string;
    site_slug?: string;
    errorClass: string;
    error: unknown;
    attempts: number;
    raw_r2_key?: string | null;
    from_addr?: string | null;
    nextActionHint?: string;
  },
): Promise<boolean> {
  const subject = `DLQ: ${args.site_slug ?? 'unknown'} - ${args.errorClass} - ${args.request_id}`;
  const body = [
    `A queue job exceeded its retry budget and landed in the DLQ.`,
    ``,
    `request_id:    ${args.request_id}`,
    `site_slug:     ${args.site_slug ?? '(unresolved)'}`,
    `from_addr:     ${args.from_addr ?? '(unknown)'}`,
    `error_class:   ${args.errorClass}`,
    `attempts:      ${args.attempts}`,
    `failed_at:     ${new Date().toISOString()}`,
    ``,
    `error message: ${errMessage(args.error)}`,
    ``,
    args.error instanceof Error && args.error.stack ? `stack:\n${args.error.stack}\n` : '',
    args.raw_r2_key ? `raw email R2 key: ${args.raw_r2_key}` : '',
    ``,
    `Suggested next action:`,
    `  ${args.nextActionHint ?? 'Investigate the error above. Re-enqueue with: wrangler queues producer-batch patchline-jobs ...'}`,
  ]
    .filter(Boolean)
    .join('\n');

  return notify(env, {
    errorClass: args.errorClass,
    request_id: args.request_id,
    site_slug: args.site_slug,
    subject,
    body,
    detail: { attempts: args.attempts, errorClass: args.errorClass },
  });
}

// ---------------------------------------------------------------------------
// MIME builder - minimal RFC 5322 message. Plain text only.
// ---------------------------------------------------------------------------

function buildMime(opts: { from: string; to: string; subject: string; body: string }): string {
  const date = new Date().toUTCString();
  const messageId = `<${crypto.randomUUID()}@patchline-worker>`;
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${date}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
  ].join('\r\n');
  const body = opts.body.replace(/\r?\n/g, '\r\n');
  return `${headers}\r\n\r\n${body}\r\n`;
}

/** RFC 2047 encoded-word for non-ASCII subjects; ASCII passes through. */
function encodeHeader(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return `=?utf-8?B?${b64}?=`;
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}
