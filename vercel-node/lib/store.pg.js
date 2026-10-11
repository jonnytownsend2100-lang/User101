import { DEFAULTS, pgClaimSQL } from '../lib/claim.js';

/**
 * Postgres-backed store. The pool is injected so this module never imports
 * `pg` at load time (keeps tests dependency-free).
 */
export function makePgStore(pool, { retryBaseMs = DEFAULTS.retryBaseMs } = {}) {
  return {
    kind: 'pg',

    async enqueue(task) {
      const r = await pool.query(
        `INSERT INTO swarm_tasks (title, kind, payload, state) VALUES ($1, $2, $3, 'pending') RETURNING id`,
        [task.title ?? '(untitled)', task.kind ?? 'echo', task.payload ?? null],
      );
      return r.rows[0].id;
    },

    /** Single-statement atomic claim: no read-then-write race possible. */
    async claim({ nodeId, lease = DEFAULTS.leaseMs }) {
      const r = await pool.query(pgClaimSQL(), [nodeId, lease, DEFAULTS.maxAttempts]);
      return r.rows[0]
        ? { ...r.rows[0], taskId: r.rows[0].id, attempts: r.rows[0].attempts }
        : null;
    },

    /** Return a task to the queue from scratch - the operator "try again". */
    async requeue(taskId) {
      const r = await pool.query(
        `UPDATE swarm_tasks
            SET state='pending', node_id=NULL, claimed_at=NULL, attempts=0,
                result=NULL, error=NULL, next_attempt_at=NULL
          WHERE id=$1`,
        [taskId],
      );
      return r.rowCount > 0;
    },

    /** Newest-first task listing for dashboards/operators. */
    async list({ limit = 200 } = {}) {
      const r = await pool.query(
        `SELECT id, title, kind, payload, state, node_id, attempts, claimed_at,
                next_attempt_at, result, error, created_at, completed_at
           FROM swarm_tasks ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return r.rows.map((x) => ({ ...x, taskId: x.id }));
    },

    async complete(taskId, result) {
      await pool.query(
        `UPDATE swarm_tasks SET state='done', result=$2, completed_at=now() WHERE id=$1`,
        [taskId, result],
      );
      return true;
    },

    /** Exponential backoff, and dead-letter once attempts are exhausted. */
    async fail(taskId, error) {
      await pool.query(
        `UPDATE swarm_tasks
            SET error = $2,
                node_id = NULL,
                claimed_at = NULL,
                state = CASE WHEN attempts >= $3 THEN 'dead' ELSE 'failed' END,
                next_attempt_at = now() + ($4 * interval '1 millisecond')
                                        * power(2, greatest(attempts - 1, 0))
          WHERE id = $1`,
        [taskId, String(error?.message ?? error), DEFAULTS.maxAttempts, retryBaseMs],
      );
      return true;
    },
  };
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS swarm_tasks (
  id              bigserial PRIMARY KEY,
  title           text        NOT NULL,
  kind            text        NOT NULL DEFAULT 'echo',
  payload         jsonb,
  state           text        NOT NULL DEFAULT 'pending',
  node_id         text,
  attempts        int         NOT NULL DEFAULT 0,
  claimed_at      timestamptz,
  next_attempt_at timestamptz,
  result          jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- Claim scan: pending work, expired leases, and backoff-elapsed retries.
CREATE INDEX IF NOT EXISTS swarm_tasks_claimable_idx
  ON swarm_tasks (created_at)
  WHERE state IN ('pending', 'claimed', 'failed');
`;
