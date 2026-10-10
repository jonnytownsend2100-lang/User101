/**
 * Shared store/registry selection. Kept in one place so the worker endpoint,
 * the inbox endpoint, and the nodes endpoint cannot drift apart.
 */
import { makeMemoryStore } from './claim.js';
import { makePgStore } from './store.pg.js';
import { makeMemoryRegistry, makePgRegistry } from './registry.js';

let pgPool = null;

async function pool() {
  if (!pgPool) {
    const { default: pg } = await import('pg');
    pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 4),
      application_name: 'vercel-swarm-node',
    });
  }
  return pgPool;
}

export async function getStore({ requireInProd = true } = {}) {
  if (process.env.DATABASE_URL) return makePgStore(await pool());
  if (requireInProd && process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production');
  }
  console.warn('[swarm] DATABASE_URL unset - EPHEMERAL memory store (demo only, not shared across invocations)');
  return makeMemoryStore();
}

export async function getRegistry() {
  if (process.env.DATABASE_URL) return makePgRegistry(await pool());
  console.warn('[swarm] DATABASE_URL unset - EPHEMERAL memory registry');
  return makeMemoryRegistry();
}
