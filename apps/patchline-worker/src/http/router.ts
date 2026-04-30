/**
 * Tiny HTTP router. Only routes the worker actually serves:
 *   GET  /healthz
 *   POST /webhooks/github
 *
 * No router lib - the surface is too small to justify one.
 */

import { handleWebhook } from '../github/webhook';
import type { Env } from '../types';

export async function handleHttp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/healthz' && request.method === 'GET') {
    return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  if (url.pathname === '/webhooks/github' && request.method === 'POST') {
    return handleWebhook(env, request);
  }

  return new Response('not found', { status: 404 });
}
