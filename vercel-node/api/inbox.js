import { getStore } from '../lib/stores.js';

/**
 * Long-poll task inbox for out-of-Vercel compute nodes.
 *
 *   GET  /api/inbox?limit=5&visibility=60000  -> lease up to `limit` tasks
 *   POST /api/inbox  { action:'ack'|'fail', messageId, result|error }
 *
 * Leasing uses the same atomic claim as the worker endpoint, so a task handed
 * to one node cannot be handed to another until the lease lapses.
 */
export const maxDuration = 60;

function authorized(req) {
  const secret = process.env.SWARM_API_KEY;
  return !secret || req.headers['x-api-key'] === secret;
}

export async function handle({ store, method, query = {}, body = {}, nodeId = 'unknown' }) {
  if (method === 'GET') {
    const limit = Math.min(Number(query.limit || 5), 50);
    const visibility = Number(query.visibility || 60_000);
    const out = [];
    for (let i = 0; i < limit; i++) {
      const t = await store.claim({ nodeId, lease: visibility });
      if (!t) break;
      out.push({
        messageId: t.taskId, taskId: t.taskId, title: t.title,
        kind: t.kind ?? undefined, payload: t.payload ?? null, attempts: t.attempts,
      });
    }
    return { status: 200, body: { ok: true, messages: out, count: out.length } };
  }

  if (method === 'POST') {
    const { action, messageId, result, error } = body;
    if (!messageId) return { status: 400, body: { ok: false, error: 'messageId is required' } };
    if (action === 'ack') {
      await store.complete(messageId, result ?? { ok: true });
      return { status: 200, body: { ok: true, acked: messageId } };
    }
    if (action === 'fail') {
      await store.fail(messageId, new Error(error || 'reported failure'));
      return { status: 200, body: { ok: true, failed: messageId } };
    }
    return { status: 400, body: { ok: false, error: "action must be 'ack' or 'fail'" } };
  }

  return { status: 405, body: { ok: false, error: 'GET or POST only' } };
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const nodeId = req.headers['x-swarm-node'] || req.query?.node || 'external';
  const store = await getStore();
  const { status, body } = await handle({
    store, method: req.method, query: req.query ?? {}, body: req.body ?? {}, nodeId,
  });
  return res.status(status).json(body);
}
