/**
 * Queue consumer.
 *
 * Bound to TWO queues from the same handler:
 *   - patchline-jobs       -> normalize + create GitHub issue
 *   - patchline-jobs-dlq   -> notify admin, ack (terminal)
 *
 * Branching is by batch.queue. We deliberately use `msg.retry()` instead of
 * throwing for known-transient failures so we get explicit backoff control.
 */

import { audit } from '../db/audit';
import * as repo from '../db/repo';
import { GithubAuthError } from '../github/app';
import { createIssue, GithubApiError } from '../github/client';
import { LABELS } from '../github/labels';
import { newChangeRequestId, newIssueRowId } from '../lib/ids';
import { log } from '../lib/logger';
import { notifyDlqFailure } from '../lib/notify';
import { presignGet } from '../storage/r2';
import type { Env, QueueMessage } from '../types';
import { buildIssueBody, buildIssueTitle, type PresignedAttachment } from './issueBuilder';
import { normalize } from './normalizer';

export async function handleQueueBatch(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  if (batch.queue === env.DLQ_NAME) {
    return handleDlq(batch as MessageBatch<unknown>, env);
  }
  return handleNormalize(batch, env);
}

// ---------------------------------------------------------------------------
// Main: normalize + create issue
// ---------------------------------------------------------------------------

async function handleNormalize(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      if (msg.body.type !== 'normalize') {
        log.warn('unknown queue message type', { event: 'queue_unknown_type', body: msg.body });
        msg.ack();
        continue;
      }
      await processNormalize(env, msg.body.request_id);
      msg.ack();
    } catch (e) {
      const transient = isTransient(e);
      log.error('normalize failed', {
        event: 'normalize_failed',
        request_id: (msg.body as { request_id?: string }).request_id,
        attempts: msg.attempts,
        transient,
      }, e);
      if (transient) {
        msg.retry({ delaySeconds: backoffSeconds(msg.attempts) });
      } else {
        // Permanent: ack and let it land in DLQ via explicit fail-fast?
        // Cloudflare moves to DLQ only after max_retries; if we know it's
        // permanent we still want it there for the admin notify, so re-throw.
        throw e;
      }
    }
  }
}

async function processNormalize(env: Env, request_id: string): Promise<void> {
  const ctx = await repo.loadRequestContext(env.patchline_db, request_id);

  const norm = normalize({
    subject: ctx.email.subject,
    text_body: ctx.email.text_body,
    has_attachments: ctx.attachments.length > 0,
  });

  const change = {
    id: newChangeRequestId(),
    inbound_email_id: ctx.email.id,
    site_id: ctx.site.id,
    edit_type: norm.edit_type,
    payload_json: JSON.stringify(norm.payload),
    summary: norm.summary,
    created_at: Date.now(),
  };
  await repo.insertChangeRequest(env.patchline_db, change);
  await repo.setInboundStatus(env.patchline_db, request_id, 'normalized');

  const presigned: PresignedAttachment[] = await Promise.all(
    ctx.attachments.map(async (a) => ({
      filename: a.filename,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      url: await presignGet(env, a.r2_key),
    })),
  );

  const title = buildIssueTitle(change, ctx.site);
  const body = buildIssueBody({
    request_id,
    email: ctx.email,
    change,
    site: ctx.site,
    repo: ctx.repo,
    attachments: presigned,
  });

  const labels: string[] = [LABELS.CLIENT_REQUEST, LABELS.NEEDS_TRIAGE];
  if (norm.edit_type === 'unknown') labels.push(LABELS.NEEDS_CLARIFICATION);

  const issue = await createIssue(env, {
    owner: ctx.repo.github_owner,
    repo: ctx.repo.github_repo,
    installation_id: ctx.repo.github_installation_id,
    title,
    body,
    labels,
  });

  await repo.insertGithubIssue(env.patchline_db, {
    id: newIssueRowId(),
    change_request_id: change.id,
    site_repo_id: ctx.repo.id,
    issue_number: issue.number,
    created_at: Date.now(),
  });
  await repo.setInboundStatus(env.patchline_db, request_id, 'issue_created');

  await audit(env.patchline_db, {
    request_id,
    actor: 'queue_consumer',
    event: 'issue_created',
    detail: {
      owner: ctx.repo.github_owner,
      repo: ctx.repo.github_repo,
      issue_number: issue.number,
      issue_url: issue.html_url,
      edit_type: norm.edit_type,
    },
  });

  log.info('issue created', {
    event: 'issue_created', request_id,
    site_slug: ctx.site.slug,
    issue_number: issue.number,
    edit_type: norm.edit_type,
  });
}

// ---------------------------------------------------------------------------
// DLQ: terminal notify-and-ack
// ---------------------------------------------------------------------------

async function handleDlq(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body as { type?: string; request_id?: string } | null;
    const request_id = body?.request_id ?? '(unknown)';

    let site_slug: string | undefined;
    let from_addr: string | null = null;
    let raw_r2_key: string | null = null;
    try {
      if (body?.request_id) {
        const email = await repo.getInboundEmail(env.patchline_db, body.request_id);
        site_slug = email?.site_slug ?? undefined;
        from_addr = email?.from_addr ?? null;
        raw_r2_key = email?.raw_r2_key ?? null;
        if (email) {
          await repo.setInboundStatus(env.patchline_db, body.request_id, 'error');
        }
      }
    } catch (e) {
      log.warn('dlq context hydrate failed', { event: 'dlq_hydrate_failed', request_id }, e);
    }

    await audit(env.patchline_db, {
      request_id,
      actor: 'dlq_consumer',
      event: 'dlq_received',
      detail: { body, attempts: msg.attempts },
    });

    await notifyDlqFailure(env, {
      request_id,
      site_slug,
      errorClass: 'queue_max_retries_exceeded',
      error: new Error(`Job exhausted retries for request_id ${request_id}`),
      attempts: msg.attempts,
      raw_r2_key,
      from_addr,
      nextActionHint:
        'Check Worker logs (npx wrangler tail) for the original failure cause around the time of this event.',
    });

    msg.ack();
  }
}

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

function isTransient(e: unknown): boolean {
  if (e instanceof GithubAuthError) return true; // could be a temporary token mint blip
  if (e instanceof GithubApiError) {
    if (e.status === 429) return true;             // rate limited
    if (e.status >= 500 && e.status <= 599) return true; // upstream blip
    return false;                                  // 4xx are usually permanent
  }
  // Network-y errors (TypeError from fetch) are transient by default.
  if (e instanceof TypeError) return true;
  return false;
}

function backoffSeconds(attempts: number): number {
  // 30, 90, 270 seconds (capped). Keeps within retry_delay floor while
  // giving GitHub blips room to clear.
  return Math.min(30 * Math.pow(3, Math.max(0, attempts - 1)), 600);
}
