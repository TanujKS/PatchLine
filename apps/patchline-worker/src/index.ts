/**
 * patchline-worker - single Cloudflare Worker entrypoint.
 *
 * Routes:
 *   email()  - inbound mail at agentdev+<slug>@tanuj.xyz from Cloudflare Email Routing
 *   queue()  - main jobs queue + DLQ (branched on batch.queue inside the consumer)
 *   fetch()  - HTTP: /webhooks/github + /healthz
 *
 * All real work lives in the per-concern modules; this file is just wiring.
 */

import { handleEmail } from './email/handler';
import { handleHttp } from './http/router';
import { handleQueueBatch } from './queue/consumer';
import type { Env, QueueMessage } from './types';

export default {
  async email(message, env, _ctx): Promise<void> {
    await handleEmail(message, env);
  },

  async queue(batch, env, _ctx): Promise<void> {
    await handleQueueBatch(batch, env);
  },

  async fetch(request, env, _ctx): Promise<Response> {
    return handleHttp(request, env);
  },
} satisfies ExportedHandler<Env, QueueMessage>;
