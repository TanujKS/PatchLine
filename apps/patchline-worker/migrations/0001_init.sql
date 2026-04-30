-- Patchline agentdev v1 schema.
-- All ids are TEXT (ULID). All timestamps are INTEGER epoch milliseconds.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE sites (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  slug        TEXT NOT NULL UNIQUE,    -- the +slug part of agentdev+<slug>@tanuj.xyz
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_sites_client ON sites(client_id);

CREATE TABLE site_repos (
  id                       TEXT PRIMARY KEY,
  site_id                  TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  github_owner             TEXT NOT NULL,
  github_repo              TEXT NOT NULL,
  github_installation_id   INTEGER NOT NULL,
  default_branch           TEXT NOT NULL DEFAULT 'main',
  allowed_globs            TEXT,        -- JSON array of glob strings; NULL = unrestricted
  UNIQUE(github_owner, github_repo)
);

CREATE INDEX idx_site_repos_site ON site_repos(site_id);

-- ---------------------------------------------------------------------------
-- Sender allowlist
--   email IS NOT NULL  -> allow this exact address
--   domain IS NOT NULL -> allow any sender at this domain
--   site_id IS NOT NULL -> restrict allowance to a single site (else any site)
-- ---------------------------------------------------------------------------

CREATE TABLE allowed_senders (
  id        TEXT PRIMARY KEY,
  email     TEXT,
  domain    TEXT,
  site_id   TEXT REFERENCES sites(id) ON DELETE CASCADE,
  note      TEXT,
  CHECK (email IS NOT NULL OR domain IS NOT NULL)
);

CREATE INDEX idx_allowed_senders_email ON allowed_senders(email);
CREATE INDEX idx_allowed_senders_domain ON allowed_senders(domain);

-- ---------------------------------------------------------------------------
-- Inbound email + attachments
-- ---------------------------------------------------------------------------

CREATE TABLE inbound_emails (
  id            TEXT PRIMARY KEY,            -- request_id (ULID)
  message_id    TEXT UNIQUE,                 -- RFC 5322 Message-ID for dedup
  from_addr     TEXT NOT NULL,
  to_addr       TEXT NOT NULL,
  site_slug     TEXT,                        -- parsed +slug; nullable so we can store rejects too
  site_id       TEXT REFERENCES sites(id) ON DELETE SET NULL,
  subject       TEXT,
  text_body     TEXT,
  html_body     TEXT,
  raw_r2_key    TEXT,                        -- R2 key for raw .eml
  received_at   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','normalized','issue_created','rejected','error'))
);

CREATE INDEX idx_inbound_status ON inbound_emails(status);
CREATE INDEX idx_inbound_received ON inbound_emails(received_at);

CREATE TABLE email_attachments (
  id                TEXT PRIMARY KEY,
  inbound_email_id  TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
  filename          TEXT NOT NULL,
  mime_type         TEXT,
  size_bytes        INTEGER,
  r2_key            TEXT NOT NULL
);

CREATE INDEX idx_attachments_email ON email_attachments(inbound_email_id);

-- ---------------------------------------------------------------------------
-- Normalized request + GitHub artifacts
-- ---------------------------------------------------------------------------

CREATE TABLE change_requests (
  id                 TEXT PRIMARY KEY,
  inbound_email_id   TEXT NOT NULL REFERENCES inbound_emails(id) ON DELETE CASCADE,
  site_id            TEXT NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  edit_type          TEXT NOT NULL
                     CHECK (edit_type IN (
                       'replace_text',
                       'replace_image',
                       'remove_image',
                       'update_phone',
                       'update_email',
                       'update_hours',
                       'update_address',
                       'add_content_item',
                       'remove_content_item',
                       'add_asset',
                       'unknown'
                     )),
  payload_json       TEXT NOT NULL,
  summary            TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_change_requests_site ON change_requests(site_id);
CREATE INDEX idx_change_requests_email ON change_requests(inbound_email_id);

CREATE TABLE github_issues (
  id                  TEXT PRIMARY KEY,
  change_request_id   TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  site_repo_id        TEXT NOT NULL REFERENCES site_repos(id) ON DELETE RESTRICT,
  issue_number        INTEGER NOT NULL,
  state               TEXT NOT NULL DEFAULT 'open'
                      CHECK (state IN ('open','closed')),
  approved_at         INTEGER,
  created_at          INTEGER NOT NULL,
  UNIQUE(site_repo_id, issue_number)
);

CREATE INDEX idx_github_issues_cr ON github_issues(change_request_id);

CREATE TABLE github_prs (
  id                TEXT PRIMARY KEY,
  github_issue_id   TEXT REFERENCES github_issues(id) ON DELETE SET NULL,
  site_repo_id      TEXT NOT NULL REFERENCES site_repos(id) ON DELETE RESTRICT,
  pr_number         INTEGER NOT NULL,
  state             TEXT NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open','closed','merged')),
  merged_at         INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE(site_repo_id, pr_number)
);

CREATE INDEX idx_github_prs_issue ON github_prs(github_issue_id);

-- ---------------------------------------------------------------------------
-- Audit + notification dedup
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id            TEXT PRIMARY KEY,
  request_id    TEXT,                  -- nullable; ties to inbound_emails.id when relevant
  actor         TEXT NOT NULL,         -- 'email_worker' | 'queue_consumer' | 'github_webhook' | 'dlq_consumer' | 'system'
  event         TEXT NOT NULL,
  detail_json   TEXT,
  fingerprint   TEXT,                  -- used by notify.ts debounce window
  occurred_at   INTEGER NOT NULL
);

CREATE INDEX idx_audit_request ON audit_logs(request_id);
CREATE INDEX idx_audit_event ON audit_logs(event);
CREATE INDEX idx_audit_occurred ON audit_logs(occurred_at);
CREATE INDEX idx_audit_fingerprint ON audit_logs(fingerprint, occurred_at);
