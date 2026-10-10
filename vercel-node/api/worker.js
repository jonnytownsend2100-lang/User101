import { makeMemoryStore, DEFAULTS } from '../lib/claim.js';
import { makePgStore } from '../lib/store.pg.js';
import { drainOnce, makeExecutor } from '../lib/worker.js';
import { handlers } from '../lib/handlers.js';

export const maxDuration = 300;   // Hobby hard cap; Pro allows 800 (1800 extended)

/** Memory store only exists for a single invocation - never use it in prod. */
async function getStore() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 4,
      application_name: 'vercel-swarm-node',
    });
    return makePgStore(pool);
  }
  console.warn('[swarm] DATABASE_URL unset - using EPHEMERAL memory store (demo only)');
  return makeMemoryStore();
}

export const nodeId =
  process.env.SWARM_NODE_ID ||
  `vercel-${process.env.VERCEL_REGION || 'local'}-${(process.env.VERCEL_DEPLOYMENT_ID || 'dev').slice(-6)}`;

export default async function handler(req, res) {
  return createHandler()(req, res);
}

/** Injectable factory so the full request path is testable without a database. */
export function createHandler({ storeFactory = getStore, executor } = {}) {
  return async function handle(req, res) {
    // Vercel Cron sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is set.
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers?.authorization !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const store = await storeFactory();
    const execute = executor ?? makeExecutor({ handlers });

    try {
      const summary = await drainOnce(store, {
        nodeId,
        execute,
        max: Number(process.env.SWARM_MAX_TASKS || 5),
        budgetMs: Number(process.env.SWARM_BUDGET_MS || 240_000),
      });
      return res.status(200).json({ ok: true, ...summary });
    } catch (err) {
      console.error('[swarm] drain failed', err);
      return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
  };
}
