/**
 * Audit log helper. Single entry point so we can swap storage later
 * (e.g. push to Workers Analytics Engine) without touching call sites.
 */

import { newAuditId } from '../lib/ids';

export type Actor =
  | 'email_worker'
  | 'queue_consumer'
  | 'github_webhook'
  | 'dlq_consumer'
  | 'system';

export interface AuditInput {
  request_id?: string | null;
  actor: Actor;
  event: string;
  detail?: unknown;
  fingerprint?: string | null;
}

export async function audit(db: D1Database, input: AuditInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (id, request_id, actor, event, detail_json, fingerprint, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      newAuditId(),
      input.request_id ?? null,
      input.actor,
      input.event,
      input.detail !== undefined ? JSON.stringify(input.detail) : null,
      input.fingerprint ?? null,
      Date.now(),
    )
    .run();
}

/**
 * Returns true iff a row with the same fingerprint occurred within `windowMs`.
 * Used by lib/notify.ts to debounce admin email floods.
 */
export async function hasRecentFingerprint(
  db: D1Database,
  fingerprint: string,
  windowMs: number,
): Promise<boolean> {
  const since = Date.now() - windowMs;
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM audit_logs
       WHERE fingerprint = ?1 AND event = 'notify_sent' AND occurred_at >= ?2
       LIMIT 1`,
    )
    .bind(fingerprint, since)
    .first<{ x: number }>();
  return !!row;
}
