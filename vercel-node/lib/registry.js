/**
 * Node registry + liveness.
 *
 * A swarm node is only useful if the controller can tell whether it is alive.
 * This replaces the git-commit heartbeat from ../swarm with a table row.
 */

export const DEFAULT_STALE_MS = 90_000;

/** Postgres-backed registry. Pool is injected so `pg` is never imported here. */
export function makePgRegistry(pool, { staleMs = DEFAULT_STALE_MS } = {}) {
  return {
    kind: 'pg',

    async heartbeat({ nodeId, region = null, meta = null }) {
      const r = await pool.query(
        `INSERT INTO swarm_nodes (node_id, region, meta, last_seen)
              VALUES ($1, $2, $3, now())
         ON CONFLICT (node_id)
         DO UPDATE SET last_seen = now(),
                       region    = COALESCE(EXCLUDED.region, swarm_nodes.region),
                       meta      = COALESCE(EXCLUDED.meta,   swarm_nodes.meta)
           RETURNING node_id, last_seen`,
        [nodeId, region, meta],
      );
      return r.rows[0];
    },

    async list({ now = null } = {}) {
      const r = await pool.query(
        `SELECT node_id, region, meta, last_seen,
                (now() - last_seen) < ($1 || ' milliseconds')::interval AS alive
           FROM swarm_nodes
          ORDER BY last_seen DESC`,
        [staleMs],
      );
      return r.rows.map((x) => ({ ...x, nodeId: x.node_id, ageMs: now ? now - Date.parse(x.last_seen) : null }));
    },

    async reap() {
      const r = await pool.query(
        `DELETE FROM swarm_nodes
          WHERE last_seen < now() - ($1 || ' milliseconds')::interval
          RETURNING node_id`,
        [staleMs * 20],
      );
      return r.rowCount;
    },
  };
}

/** In-memory equivalent - single invocation only, used by tests. */
export function makeMemoryRegistry({ staleMs = DEFAULT_STALE_MS, now = () => Date.now() } = {}) {
  const nodes = new Map();
  return {
    kind: 'memory',

    async heartbeat({ nodeId, region = null, meta = null }) {
      const rec = { nodeId, region, meta, lastSeen: now() };
      nodes.set(nodeId, rec);
      return { node_id: nodeId, last_seen: new Date(rec.lastSeen).toISOString() };
    },

    async list() {
      const t = now();
      return [...nodes.values()].map((n) => ({
        ...n, alive: t - n.lastSeen < staleMs, ageMs: t - n.lastSeen,
      }));
    },

    async reap() {
      const t = now();
      let removed = 0;
      for (const [id, n] of nodes) {
        if (t - n.lastSeen > staleMs * 20) { nodes.delete(id); removed++; }
      }
      return removed;
    },
  };
}
