-- Patchline D1 seed script.
--
-- Edit the @-prefixed values below (look for `EDIT:`), then run:
--   cd apps/patchline-worker
--   npx wrangler d1 execute patchline-db --remote --file=../../scripts/seed.sql
--
-- Idempotency: this script uses INSERT OR IGNORE so it is safe to re-run.
-- Update existing rows with explicit UPDATE statements if needed.

-- ---------------------------------------------------------------------------
-- 1. Client
-- EDIT: client slug + name
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO clients (id, slug, name, created_at)
VALUES ('cli_acme', 'acme', 'Acme Corp', unixepoch() * 1000);

-- ---------------------------------------------------------------------------
-- 2. Site
-- EDIT: site slug (this is the +slug part of agentdev+<slug>@tanuj.xyz)
--       and the human-readable site name.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO sites (id, client_id, slug, name, created_at)
VALUES ('site_acme', 'cli_acme', 'acme', 'acme.com', unixepoch() * 1000);

-- ---------------------------------------------------------------------------
-- 3. Site repo
-- EDIT: github_owner, github_repo, github_installation_id, allowed_globs.
--       allowed_globs is a JSON array of glob patterns Claude is allowed to
--       edit. Mirror this with .claude/settings.json in the client repo.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO site_repos (
  id, site_id, github_owner, github_repo,
  github_installation_id, default_branch, allowed_globs
) VALUES (
  'repo_acme',
  'site_acme',
  'YOUR_GITHUB_ORG_OR_USER',
  'acme-website',
  0,                                        -- EDIT: real installation_id (integer)
  'main',
  '["src/content/**","src/data/**","public/images/**","public/files/**"]'
);

-- ---------------------------------------------------------------------------
-- 4. Allowed senders
--   - One row per address (or domain) you want to accept mail from.
--   - site_id NULL  = allowed for any site
--   - site_id set   = scoped to that site
--
-- EDIT: at least add yourself.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO allowed_senders (id, email, domain, site_id, note)
VALUES ('snd_admin', 'YOU@example.com', NULL, NULL, 'admin (site-wide)');

-- Example: scope a client's domain to their site only.
-- INSERT OR IGNORE INTO allowed_senders (id, email, domain, site_id, note)
-- VALUES ('snd_acme_domain', NULL, 'acmecorp.com', 'site_acme', 'Acme staff');

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
SELECT 'clients'         AS table_name, COUNT(*) AS rows FROM clients
UNION ALL
SELECT 'sites',           COUNT(*) FROM sites
UNION ALL
SELECT 'site_repos',      COUNT(*) FROM site_repos
UNION ALL
SELECT 'allowed_senders', COUNT(*) FROM allowed_senders;
