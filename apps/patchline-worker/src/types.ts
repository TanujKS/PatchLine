/**
 * Worker environment bindings + vars + secrets.
 *
 * Bindings + vars are declared in wrangler.jsonc and reflected in the
 * generated worker-configuration.d.ts (run `npm run cf-typegen` after
 * editing wrangler.jsonc).
 *
 * Secrets are pushed via `wrangler secret put` and are NOT visible to
 * `wrangler types`, so we declare them by augmenting the global Env here.
 *
 * This is the single source of truth call sites import.
 */

declare global {
  interface Env {
    // Secrets - not in wrangler.jsonc, declared here so TS sees them.
    GITHUB_APP_ID: string;
    GITHUB_APP_PRIVATE_KEY: string;  // full PEM including -----BEGIN/END-----
    GITHUB_WEBHOOK_SECRET: string;
    R2_S3_ACCESS_KEY_ID: string;
    R2_S3_SECRET_ACCESS_KEY: string;
  }
}

/**
 * Re-export the global Env type under an alias so call sites can use
 * `import type { Env } from '../types'` without depending on globals.
 */
export type Env = globalThis.Env;

/**
 * Queue payload. Tagged union so future job types are type-safe.
 */
export type QueueMessage =
  | { type: 'normalize'; request_id: string };

// ---------------------------------------------------------------------------
// Domain types - shared by repo, normalizer, issue builder, webhook handler.
// ---------------------------------------------------------------------------

export interface Client {
  id: string;
  slug: string;
  name: string;
  created_at: number;
}

export interface Site {
  id: string;
  client_id: string;
  slug: string;
  name: string;
  created_at: number;
}

export interface SiteRepo {
  id: string;
  site_id: string;
  github_owner: string;
  github_repo: string;
  github_installation_id: number;
  default_branch: string;
  /** parsed from JSON column; empty array means unrestricted */
  allowed_globs: string[];
}

export interface AllowedSender {
  id: string;
  email: string | null;
  domain: string | null;
  site_id: string | null;
  note: string | null;
}

export interface InboundEmail {
  id: string;
  message_id: string | null;
  from_addr: string;
  to_addr: string;
  site_slug: string | null;
  site_id: string | null;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  raw_r2_key: string | null;
  received_at: number;
  status: 'received' | 'normalized' | 'issue_created' | 'rejected' | 'error';
}

export interface EmailAttachment {
  id: string;
  inbound_email_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  r2_key: string;
}

export type EditType =
  | 'replace_text'
  | 'replace_image'
  | 'remove_image'
  | 'update_phone'
  | 'update_email'
  | 'update_hours'
  | 'update_address'
  | 'add_content_item'
  | 'remove_content_item'
  | 'add_asset'
  | 'unknown';

export interface ChangeRequest {
  id: string;
  inbound_email_id: string;
  site_id: string;
  edit_type: EditType;
  payload_json: string;
  summary: string;
  created_at: number;
}

export interface GithubIssueRow {
  id: string;
  change_request_id: string;
  site_repo_id: string;
  issue_number: number;
  state: 'open' | 'closed';
  approved_at: number | null;
  created_at: number;
}
