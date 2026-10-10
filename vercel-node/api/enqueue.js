import { makeMemoryStore } from '../lib/claim.js';
import { makePgStore } from '../lib/store.pg.js';

/** Same store-selection logic as the worker endpoint. */
async function getStore() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    return makePgStore(pool);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  console.warn('[swarm] enqueue: no DATABASE_URL, using ephemeral memory store');
  return makeMemoryStore();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'use POST' });
  }
  // Optional shared secret so the queue endpoint is not an open task injector.
  const secret = process.env.SWARM_API_KEY;
  if (secret && req.headers['x-api-key'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { title, kind, payload } = req.body ?? {};
  if (!title) return res.status(400).json({ error: 'title is required' });

  const store = await getStore();
  const taskId = await store.enqueue({ title, kind, payload });
  return res.status(202).json({ ok: true, taskId, node: 'enqueued' });
}
