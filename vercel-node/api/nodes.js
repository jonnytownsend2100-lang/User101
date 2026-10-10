import { getRegistry } from '../lib/stores.js';

/**
 * Node registry + liveness.
 *
 *   POST /api/nodes  { nodeId, region?, meta? }  -> heartbeat (upsert)
 *   GET  /api/nodes                              -> list nodes with alive flag
 *   DELETE /api/nodes                            -> reap long-dead rows
 */
function authorized(req) {
  const secret = process.env.SWARM_API_KEY;
  return !secret || req.headers['x-api-key'] === secret;
}

export async function handle({ registry, method, body = {} }) {
  if (method === 'POST') {
    const { nodeId, region, meta } = body;
    if (!nodeId) return { status: 400, body: { ok: false, error: 'nodeId is required' } };
    await registry.heartbeat({ nodeId, region: region ?? process.env.VERCEL_REGION ?? null, meta: meta ?? null });
    return { status: 200, body: { ok: true, nodeId } };
  }
  if (method === 'GET') {
    const nodes = await registry.list();
    return {
      status: 200,
      body: { ok: true, nodes, alive: nodes.filter((n) => n.alive).length, total: nodes.length },
    };
  }
  if (method === 'DELETE') {
    const removed = await registry.reap();
    return { status: 200, body: { ok: true, removed } };
  }
  return { status: 405, body: { ok: false, error: 'GET, POST or DELETE only' } };
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const registry = await getRegistry();
  const { status, body } = await handle({ registry, method: req.method, body: req.body ?? {} });
  return res.status(status).json(body);
}
