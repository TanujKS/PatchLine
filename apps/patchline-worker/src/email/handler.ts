/**
 * Email Worker entrypoint.
 *
 * Lifecycle:
 *   1. Parse the recipient -> resolve site (or reject).
 *   2. Parse MIME (postal-mime) once into memory.
 *   3. Reject disallowed senders.
 *   4. Dedup on Message-ID (prevents queue retry / SMTP retry duplicates).
 *   5. Persist raw + attachments to R2.
 *   6. Insert inbound_emails + email_attachments atomically (D1 batch).
 *   7. Enqueue normalize job.
 *
 * Pre-persist failures (e.g. D1 outage) are caught and trigger an admin
 * notification + a temporary SMTP reject so the sender's MTA bounces.
 */

import { audit } from '../db/audit';
import * as repo from '../db/repo';
import { newAttachmentId, newRequestId } from '../lib/ids';
import { log } from '../lib/logger';
import { notify } from '../lib/notify';
import { putAttachment, putRawEmail } from '../storage/r2';
import type { Env } from '../types';
import { parseRaw } from './parser';
import { isSenderAllowed, resolveSiteFromAddress } from './resolver';

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const received_at = Date.now();
  const to = message.to;
  const from = message.from;

  try {
    // 1. Address resolution (cheap, do before MIME parse)
    const addrResult = await resolveSiteFromAddress(env, to);
    if (!addrResult.ok) {
      const e = addrResult.error;
      log.info('email rejected', { event: 'email_rejected', from, to, reason: e.kind });
      message.setReject(rejectMessageFor(e));
      return;
    }
    const { site, site_slug } = addrResult.value;

    // 2. Parse MIME
    const { parsed, rawBytes } = await parseRaw(message.raw);

    // 3. Sender allowlist
    const allowed = await isSenderAllowed(env, from, site.id);
    if (!allowed) {
      log.info('sender not allowed', { event: 'email_sender_not_allowed', from, to, site_slug });
      message.setReject('Sender not authorized for this address.');
      return;
    }

    // 4. Dedup
    if (parsed.messageId) {
      const dup = await repo.isDuplicateMessageId(env.patchline_db, parsed.messageId);
      if (dup) {
        await audit(env.patchline_db, {
          actor: 'email_worker',
          event: 'email_duplicate_ignored',
          detail: { from, to, message_id: parsed.messageId, site_slug },
        });
        log.info('duplicate message-id ignored', {
          event: 'email_duplicate_ignored', from, to, message_id: parsed.messageId,
        });
        return;
      }
    }

    // 5. Persist to R2
    const request_id = newRequestId();
    const raw_r2_key = await putRawEmail(env, request_id, rawBytes);
    const storedAttachments = await Promise.all(
      parsed.attachments.map(async (a) => ({
        id: newAttachmentId(),
        inbound_email_id: request_id,
        filename: a.filename,
        mime_type: a.mimeType,
        size_bytes: a.size,
        r2_key: await putAttachment(env, request_id, a.filename, a.content, a.mimeType ?? undefined),
      })),
    );

    // 6. D1 batch insert
    await repo.insertInboundWithAttachments(
      env.patchline_db,
      {
        id: request_id,
        message_id: parsed.messageId,
        from_addr: from,
        to_addr: to,
        site_slug,
        site_id: site.id,
        subject: parsed.subject,
        text_body: parsed.text,
        html_body: parsed.html,
        raw_r2_key,
        received_at,
      },
      storedAttachments,
    );

    // 7. Enqueue normalize job
    await env.patchline_jobs.send({ type: 'normalize', request_id });

    await audit(env.patchline_db, {
      request_id,
      actor: 'email_worker',
      event: 'email_received',
      detail: {
        from, to, site_slug,
        subject: parsed.subject,
        attachment_count: storedAttachments.length,
        raw_r2_key,
      },
    });

    log.info('email accepted', {
      event: 'email_accepted', request_id, site_slug, from, to,
      attachments: storedAttachments.length,
    });
  } catch (e) {
    // Pre-persist or persist failure. We notify admin and bounce the email
    // so the sender's MTA retries (or surfaces the bounce).
    log.error('email handler failed', { event: 'email_handler_failed', from, to }, e);
    try {
      await notify(env, {
        errorClass: 'email_handler_failure',
        subject: `Email ingest failed: ${from} -> ${to}`,
        body: [
          `An inbound email failed before it could be persisted.`,
          ``,
          `from:        ${from}`,
          `to:          ${to}`,
          `received_at: ${new Date(received_at).toISOString()}`,
          ``,
          `error: ${e instanceof Error ? e.message : String(e)}`,
          ``,
          e instanceof Error && e.stack ? `stack:\n${e.stack}` : '',
          ``,
          `Sender's MTA will be told the message was temporarily rejected.`,
        ].filter(Boolean).join('\n'),
        detail: { from, to },
      });
    } catch {
      // notify itself failed; nothing more we can do here.
    }
    message.setReject('Temporary failure receiving your request. Admin has been notified. Please retry later.');
  }
}

function rejectMessageFor(e: { kind: string }): string {
  switch (e.kind) {
    case 'unknown_address': return 'Unknown address.';
    case 'unknown_site':    return 'Unknown site identifier.';
    default:                return 'Address not accepted.';
  }
}
