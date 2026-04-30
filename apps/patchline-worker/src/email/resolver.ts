/**
 * Address resolution + sender allowlist checks.
 *
 * Inbound address must match agentdev+<slug>@tanuj.xyz. The slug maps to
 * sites.slug. Senders are checked against the allowed_senders table.
 */

import { findAllowance, getSiteBySlug } from '../db/repo';
import { err, ok, type Result } from '../lib/result';
import type { Env, Site } from '../types';

export type ResolveError =
  | { kind: 'unknown_address'; reason: string }
  | { kind: 'unknown_site'; slug: string }
  | { kind: 'sender_not_allowed'; from: string; site_slug: string };

export interface Resolved {
  site: Site;
  site_slug: string;
}

/**
 * Validates the recipient address and resolves to a site. Does NOT check
 * the sender allowlist - that's a separate step so we can always store the
 * inbound row before deciding to reject.
 */
export async function resolveSiteFromAddress(
  env: Env,
  to_addr: string,
): Promise<Result<Resolved, ResolveError>> {
  const slug = parseSiteSlug(to_addr, env.EMAIL_LOCAL_PART, env.EMAIL_DOMAIN);
  if (!slug) {
    return err({ kind: 'unknown_address', reason: `expected ${env.EMAIL_LOCAL_PART}+<slug>@${env.EMAIL_DOMAIN}` });
  }
  const site = await getSiteBySlug(env.patchline_db, slug);
  if (!site) {
    return err({ kind: 'unknown_site', slug });
  }
  return ok({ site, site_slug: slug });
}

export async function isSenderAllowed(
  env: Env,
  from_addr: string,
  site_id: string,
): Promise<boolean> {
  const allowance = await findAllowance(env.patchline_db, from_addr.toLowerCase(), site_id);
  return !!allowance;
}

/**
 * Parses agentdev+<slug>@tanuj.xyz -> "<slug>".
 * Case-insensitive. Returns null if shape doesn't match.
 */
export function parseSiteSlug(to: string, localPart: string, domain: string): string | null {
  const lc = to.trim().toLowerCase();
  const expectedDomain = '@' + domain.toLowerCase();
  if (!lc.endsWith(expectedDomain)) return null;
  const local = lc.slice(0, -expectedDomain.length);
  const prefix = localPart.toLowerCase() + '+';
  if (!local.startsWith(prefix)) return null;
  const slug = local.slice(prefix.length);
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(slug)) return null;
  return slug;
}
