/**
 * GitHub webhook receiver.
 *
 * - Verifies X-Hub-Signature-256 against GITHUB_WEBHOOK_SECRET.
 * - Routes events to small handlers that update D1 + audit.
 *
 * Worker never invokes Claude or Codex from here; GitHub Actions in the client
 * repo are the trigger for that. We only mirror state into D1.
 */

import { audit } from '../db/audit';
import * as repo from '../db/repo';
import { newPrRowId } from '../lib/ids';
import { log } from '../lib/logger';
import type { Env } from '../types';
import { LABELS } from './labels';
import { addLabels, closeIssue, removeLabel } from './client';

export async function handleWebhook(env: Env, request: Request): Promise<Response> {
  const signature = request.headers.get('X-Hub-Signature-256');
  const event = request.headers.get('X-GitHub-Event');
  const delivery = request.headers.get('X-GitHub-Delivery');

  if (!signature || !event) {
    return new Response('missing webhook headers', { status: 400 });
  }

  const raw = await request.text();
  const ok = await verifySignature(env.GITHUB_WEBHOOK_SECRET, raw, signature);
  if (!ok) {
    log.warn('webhook signature invalid', { event: 'webhook_bad_sig', delivery });
    return new Response('invalid signature', { status: 401 });
  }

  let payload: GithubEventPayload;
  try {
    payload = JSON.parse(raw) as GithubEventPayload;
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  try {
    switch (event) {
      case 'issues':
        await onIssues(env, payload as IssuesEvent);
        break;
      case 'pull_request':
        await onPullRequest(env, payload as PullRequestEvent);
        break;
      case 'ping':
        log.info('webhook ping', { event: 'webhook_ping', delivery });
        break;
      default:
        log.info('webhook event ignored', { event: 'webhook_ignored', delivery, type: event });
        break;
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    log.error('webhook handler threw', { event: 'webhook_error', delivery, type: event }, e);
    return new Response('handler error', { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Issue events
// ---------------------------------------------------------------------------

async function onIssues(env: Env, p: IssuesEvent): Promise<void> {
  const owner = p.repository.owner.login;
  const repoName = p.repository.name;
  const issueNumber = p.issue.number;

  const siteRepo = await repo.getSiteRepoByOwnerName(env.patchline_db, owner, repoName);
  if (!siteRepo) {
    log.warn('webhook for unknown repo', { event: 'webhook_unknown_repo', owner, repo: repoName });
    return;
  }
  const issueRow = await repo.getGithubIssueByNumber(env.patchline_db, siteRepo.id, issueNumber);
  if (!issueRow) {
    log.info('webhook for issue not in D1', { event: 'webhook_unknown_issue', owner, repo: repoName, issueNumber });
    return;
  }

  if (p.action === 'labeled' && isAgentApprovalLabel(p.label?.name)) {
    const now = Date.now();
    await repo.setIssueApproved(env.patchline_db, issueRow.id, now);
    await audit(env.patchline_db, {
      request_id: issueRow.change_request_id,
      actor: 'github_webhook',
      event: 'issue_approved',
      detail: { owner, repo: repoName, issueNumber, label: p.label?.name, by: p.sender?.login },
    });
    log.info('issue approved', {
      event: 'issue_approved',
      request_id: issueRow.change_request_id,
      issueNumber,
      label: p.label?.name,
    });
    return;
  }

  if (p.action === 'closed') {
    await repo.setIssueState(env.patchline_db, issueRow.id, 'closed');
    await audit(env.patchline_db, {
      request_id: issueRow.change_request_id,
      actor: 'github_webhook',
      event: 'issue_closed',
      detail: { owner, repo: repoName, issueNumber, by: p.sender?.login },
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// PR events
// ---------------------------------------------------------------------------

async function onPullRequest(env: Env, p: PullRequestEvent): Promise<void> {
  const owner = p.repository.owner.login;
  const repoName = p.repository.name;
  const pr = p.pull_request;

  const siteRepo = await repo.getSiteRepoByOwnerName(env.patchline_db, owner, repoName);
  if (!siteRepo) return;

  // Try to link this PR to an issue we know about.
  const issueNumber = extractClosedIssueNumber(pr.body) ?? extractIssueNumberFromBranch(pr.head?.ref);
  const issueRow = issueNumber
    ? await repo.getGithubIssueByNumber(env.patchline_db, siteRepo.id, issueNumber)
    : null;

  const state: 'open' | 'closed' | 'merged' =
    p.action === 'closed' && pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';

  await repo.upsertGithubPr(env.patchline_db, {
    id: newPrRowId(),
    github_issue_id: issueRow?.id ?? null,
    site_repo_id: siteRepo.id,
    pr_number: pr.number,
    state,
    merged_at: state === 'merged' ? Date.now() : null,
    created_at: Date.parse(pr.created_at) || Date.now(),
  });

  await audit(env.patchline_db, {
    request_id: issueRow?.change_request_id ?? null,
    actor: 'github_webhook',
    event: `pr_${p.action}`,
    detail: { owner, repo: repoName, pr_number: pr.number, state, linkedIssue: issueNumber ?? null },
  });

  if (!issueRow) return;

  // Best-effort label updates - we do NOT throw if these fail; they're cosmetic.
  try {
    if (p.action === 'opened') {
      await removeLabel(env, {
        owner, repo: repoName, installation_id: siteRepo.github_installation_id,
        issue_number: issueRow.issue_number, label: LABELS.AGENT_RUNNING,
      });
      await addLabels(env, {
        owner, repo: repoName, installation_id: siteRepo.github_installation_id,
        issue_number: issueRow.issue_number, labels: [LABELS.PR_OPENED],
      });
    } else if (state === 'merged') {
      await addLabels(env, {
        owner, repo: repoName, installation_id: siteRepo.github_installation_id,
        issue_number: issueRow.issue_number, labels: [LABELS.DONE],
      });
      await closeIssue(env, {
        owner, repo: repoName, installation_id: siteRepo.github_installation_id,
        issue_number: issueRow.issue_number,
      });
      await repo.setIssueState(env.patchline_db, issueRow.id, 'closed');
    }
  } catch (e) {
    log.warn('label/close update failed (cosmetic)', {
      event: 'label_update_failed', owner, repo: repoName, issueNumber: issueRow.issue_number,
    }, e);
  }
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

async function verifySignature(secret: string, raw: string, signature: string): Promise<boolean> {
  if (!signature.startsWith('sha256=')) return false;
  const provided = signature.slice('sha256='.length);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const expected = bytesToHex(new Uint8Array(sig));
  return timingSafeEqual(expected, provided);
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// PR/issue body parsing helpers
// ---------------------------------------------------------------------------

function extractClosedIssueNumber(body?: string | null): number | null {
  if (!body) return null;
  const m = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

function extractIssueNumberFromBranch(ref?: string | null): number | null {
  if (!ref) return null;
  const m = ref.match(/(?:^|[/-])issue[-_/](\d+)\b/i);
  return m ? Number(m[1]) : null;
}

function isAgentApprovalLabel(label?: string | null): boolean {
  return label === LABELS.APPROVE_FOR_CLAUDE || label === LABELS.APPROVE_FOR_CODEX;
}

// ---------------------------------------------------------------------------
// Minimal type shapes for events we handle. GitHub's payload is large; we
// only assert what we read.
// ---------------------------------------------------------------------------

interface GithubRepository {
  name: string;
  owner: { login: string };
}

interface GithubSender { login?: string }

interface GithubEventPayload {
  action: string;
  repository: GithubRepository;
  sender?: GithubSender;
}

interface IssuesEvent extends GithubEventPayload {
  action: 'opened' | 'edited' | 'labeled' | 'unlabeled' | 'closed' | 'reopened' | string;
  issue: { number: number; title: string; body?: string | null };
  label?: { name: string };
}

interface PullRequestEvent extends GithubEventPayload {
  action: 'opened' | 'closed' | 'reopened' | 'edited' | 'synchronize' | string;
  pull_request: {
    number: number;
    state: 'open' | 'closed';
    merged: boolean;
    body?: string | null;
    head?: { ref?: string };
    created_at: string;
  };
}
