/**
 * Thin GitHub REST client. Only the surface we actually use:
 *   - create issue
 *   - add labels
 *   - comment on issue
 *   - update issue (close, etc.)
 *
 * Everything goes through one `request()` so retry/error semantics live in
 * one place. Auth is per-installation via getInstallationToken.
 */

import { getInstallationToken } from './app';
import type { Env } from '../types';

const API = 'https://api.github.com';
const UA = 'patchline-worker';

export class GithubApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, msg: string) {
    super(msg);
    this.name = 'GithubApiError';
    this.status = status;
    this.body = body;
  }
}

export interface CreateIssueInput {
  owner: string;
  repo: string;
  installation_id: number;
  title: string;
  body: string;
  labels?: string[];
}

export interface CreatedIssue {
  number: number;
  id: number;
  html_url: string;
  node_id: string;
}

export async function createIssue(env: Env, input: CreateIssueInput): Promise<CreatedIssue> {
  return request<CreatedIssue>(env, input.installation_id, 'POST', `/repos/${input.owner}/${input.repo}/issues`, {
    title: input.title,
    body: input.body,
    labels: input.labels ?? [],
  });
}

export async function addLabels(
  env: Env,
  args: { owner: string; repo: string; installation_id: number; issue_number: number; labels: string[] },
): Promise<void> {
  await request(env, args.installation_id, 'POST',
    `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}/labels`,
    { labels: args.labels });
}

export async function removeLabel(
  env: Env,
  args: { owner: string; repo: string; installation_id: number; issue_number: number; label: string },
): Promise<void> {
  // 404 here is fine - means the label wasn't on the issue.
  await request(env, args.installation_id, 'DELETE',
    `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}/labels/${encodeURIComponent(args.label)}`,
    undefined,
    { allow404: true });
}

export async function commentOnIssue(
  env: Env,
  args: { owner: string; repo: string; installation_id: number; issue_number: number; body: string },
): Promise<void> {
  await request(env, args.installation_id, 'POST',
    `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}/comments`,
    { body: args.body });
}

export async function closeIssue(
  env: Env,
  args: { owner: string; repo: string; installation_id: number; issue_number: number },
): Promise<void> {
  await request(env, args.installation_id, 'PATCH',
    `/repos/${args.owner}/${args.repo}/issues/${args.issue_number}`,
    { state: 'closed' });
}

// ---------------------------------------------------------------------------

async function request<T = unknown>(
  env: Env,
  installation_id: number,
  method: string,
  path: string,
  body?: unknown,
  opts: { allow404?: boolean } = {},
): Promise<T> {
  const token = await getInstallationToken(env, installation_id);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (opts.allow404 && res.status === 404) {
    return undefined as T;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GithubApiError(res.status, text, `GitHub ${method} ${path} failed: ${res.status} ${res.statusText}`);
  }

  // 204 No Content is valid for some endpoints.
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}
