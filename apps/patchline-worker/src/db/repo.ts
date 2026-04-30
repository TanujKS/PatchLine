/**
 * Single SQL surface. Every query in the codebase lives here; nothing else
 * should construct SQL strings or call .prepare() directly. Keeps the schema
 * change blast radius to one file.
 */

import type {
  AllowedSender,
  ChangeRequest,
  EmailAttachment,
  EditType,
  GithubIssueRow,
  InboundEmail,
  Site,
  SiteRepo,
} from '../types';

// ---------------------------------------------------------------------------
// Sites + repos
// ---------------------------------------------------------------------------

export async function getSiteBySlug(db: D1Database, slug: string): Promise<Site | null> {
  return db
    .prepare('SELECT * FROM sites WHERE slug = ?1')
    .bind(slug)
    .first<Site>();
}

export async function getSiteRepoForSite(db: D1Database, site_id: string): Promise<SiteRepo | null> {
  const row = await db
    .prepare('SELECT * FROM site_repos WHERE site_id = ?1 LIMIT 1')
    .bind(site_id)
    .first<Omit<SiteRepo, 'allowed_globs'> & { allowed_globs: string | null }>();
  if (!row) return null;
  return {
    ...row,
    allowed_globs: row.allowed_globs ? JSON.parse(row.allowed_globs) as string[] : [],
  };
}

export async function getSiteRepoByOwnerName(
  db: D1Database,
  owner: string,
  repo: string,
): Promise<SiteRepo | null> {
  const row = await db
    .prepare('SELECT * FROM site_repos WHERE github_owner = ?1 AND github_repo = ?2')
    .bind(owner, repo)
    .first<Omit<SiteRepo, 'allowed_globs'> & { allowed_globs: string | null }>();
  if (!row) return null;
  return {
    ...row,
    allowed_globs: row.allowed_globs ? JSON.parse(row.allowed_globs) as string[] : [],
  };
}

// ---------------------------------------------------------------------------
// Allowed senders
// ---------------------------------------------------------------------------

/**
 * Returns the most specific matching sender allowance, or null if not allowed.
 * Precedence: exact email + site > exact email > domain + site > domain.
 */
export async function findAllowance(
  db: D1Database,
  from_email: string,
  site_id: string,
): Promise<AllowedSender | null> {
  const domain = from_email.split('@')[1]?.toLowerCase() ?? '';
  return db
    .prepare(
      `SELECT * FROM allowed_senders
       WHERE (email = ?1 OR domain = ?2)
         AND (site_id IS NULL OR site_id = ?3)
       ORDER BY
         CASE WHEN email = ?1 AND site_id = ?3 THEN 0
              WHEN email = ?1                  THEN 1
              WHEN domain = ?2 AND site_id = ?3 THEN 2
              ELSE 3 END
       LIMIT 1`,
    )
    .bind(from_email.toLowerCase(), domain, site_id)
    .first<AllowedSender>();
}

// ---------------------------------------------------------------------------
// Inbound email + attachments
// ---------------------------------------------------------------------------

export interface InboundInsertInput {
  id: string;
  message_id: string | null;
  from_addr: string;
  to_addr: string;
  site_slug: string | null;
  site_id: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  raw_r2_key: string;
  received_at: number;
}

export interface AttachmentInsertInput {
  id: string;
  inbound_email_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  r2_key: string;
}

/**
 * Inserts the inbound email plus attachments atomically via D1 batch.
 * Returns the prepared statements as a batch op for the caller to await.
 */
export async function insertInboundWithAttachments(
  db: D1Database,
  email: InboundInsertInput,
  attachments: AttachmentInsertInput[],
): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO inbound_emails
         (id, message_id, from_addr, to_addr, site_slug, site_id, subject, text_body, html_body, raw_r2_key, received_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'received')`,
      )
      .bind(
        email.id,
        email.message_id,
        email.from_addr,
        email.to_addr,
        email.site_slug,
        email.site_id,
        email.subject,
        email.text_body,
        email.html_body,
        email.raw_r2_key,
        email.received_at,
      ),
    ...attachments.map((a) =>
      db
        .prepare(
          `INSERT INTO email_attachments
           (id, inbound_email_id, filename, mime_type, size_bytes, r2_key)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(a.id, a.inbound_email_id, a.filename, a.mime_type, a.size_bytes, a.r2_key),
    ),
  ];
  await db.batch(stmts);
}

export async function isDuplicateMessageId(db: D1Database, message_id: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM inbound_emails WHERE message_id = ?1 LIMIT 1')
    .bind(message_id)
    .first<{ x: number }>();
  return !!row;
}

export async function getInboundEmail(db: D1Database, request_id: string): Promise<InboundEmail | null> {
  return db
    .prepare('SELECT * FROM inbound_emails WHERE id = ?1')
    .bind(request_id)
    .first<InboundEmail>();
}

export async function listAttachments(
  db: D1Database,
  inbound_email_id: string,
): Promise<EmailAttachment[]> {
  const r = await db
    .prepare('SELECT * FROM email_attachments WHERE inbound_email_id = ?1 ORDER BY filename')
    .bind(inbound_email_id)
    .all<EmailAttachment>();
  return r.results ?? [];
}

export async function setInboundStatus(
  db: D1Database,
  request_id: string,
  status: InboundEmail['status'],
): Promise<void> {
  await db
    .prepare('UPDATE inbound_emails SET status = ?1 WHERE id = ?2')
    .bind(status, request_id)
    .run();
}

// ---------------------------------------------------------------------------
// Change requests + GitHub artifacts
// ---------------------------------------------------------------------------

export async function insertChangeRequest(
  db: D1Database,
  cr: {
    id: string;
    inbound_email_id: string;
    site_id: string;
    edit_type: EditType;
    payload_json: string;
    summary: string;
    created_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO change_requests (id, inbound_email_id, site_id, edit_type, payload_json, summary, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(cr.id, cr.inbound_email_id, cr.site_id, cr.edit_type, cr.payload_json, cr.summary, cr.created_at)
    .run();
}

export async function insertGithubIssue(
  db: D1Database,
  issue: Omit<GithubIssueRow, 'state' | 'approved_at'> & {
    state?: GithubIssueRow['state'];
    approved_at?: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_issues (id, change_request_id, site_repo_id, issue_number, state, approved_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      issue.id,
      issue.change_request_id,
      issue.site_repo_id,
      issue.issue_number,
      issue.state ?? 'open',
      issue.approved_at ?? null,
      issue.created_at,
    )
    .run();
}

export async function getGithubIssueByNumber(
  db: D1Database,
  site_repo_id: string,
  issue_number: number,
): Promise<GithubIssueRow | null> {
  return db
    .prepare('SELECT * FROM github_issues WHERE site_repo_id = ?1 AND issue_number = ?2')
    .bind(site_repo_id, issue_number)
    .first<GithubIssueRow>();
}

export async function setIssueApproved(db: D1Database, id: string, approved_at: number): Promise<void> {
  await db
    .prepare('UPDATE github_issues SET approved_at = ?1 WHERE id = ?2')
    .bind(approved_at, id)
    .run();
}

export async function setIssueState(db: D1Database, id: string, state: GithubIssueRow['state']): Promise<void> {
  await db
    .prepare('UPDATE github_issues SET state = ?1 WHERE id = ?2')
    .bind(state, id)
    .run();
}

export async function upsertGithubPr(
  db: D1Database,
  pr: {
    id: string;
    github_issue_id: string | null;
    site_repo_id: string;
    pr_number: number;
    state: 'open' | 'closed' | 'merged';
    merged_at: number | null;
    created_at: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO github_prs (id, github_issue_id, site_repo_id, pr_number, state, merged_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(site_repo_id, pr_number) DO UPDATE SET
         state = excluded.state,
         merged_at = excluded.merged_at,
         github_issue_id = COALESCE(excluded.github_issue_id, github_prs.github_issue_id)`,
    )
    .bind(pr.id, pr.github_issue_id, pr.site_repo_id, pr.pr_number, pr.state, pr.merged_at, pr.created_at)
    .run();
}

// ---------------------------------------------------------------------------
// Compound loaders
// ---------------------------------------------------------------------------

export interface ResolvedRequest {
  email: InboundEmail;
  attachments: EmailAttachment[];
  site: Site;
  repo: SiteRepo;
}

/**
 * Loads the full context the queue consumer needs to process a request.
 * Throws if any link is missing - those are exceptional cases that should
 * land in the DLQ for human review (site deleted mid-flight, etc.).
 */
export async function loadRequestContext(
  db: D1Database,
  request_id: string,
): Promise<ResolvedRequest> {
  const email = await getInboundEmail(db, request_id);
  if (!email) throw new Error(`inbound_email ${request_id} not found`);
  if (!email.site_id) throw new Error(`inbound_email ${request_id} has no site_id`);

  const [site, attachments] = await Promise.all([
    db.prepare('SELECT * FROM sites WHERE id = ?1').bind(email.site_id).first<Site>(),
    listAttachments(db, request_id),
  ]);
  if (!site) throw new Error(`site ${email.site_id} not found`);

  const repo = await getSiteRepoForSite(db, site.id);
  if (!repo) throw new Error(`site_repo for site ${site.id} not found`);

  return { email, attachments, site, repo };
}
