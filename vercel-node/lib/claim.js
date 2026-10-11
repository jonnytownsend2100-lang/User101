/**
 * Pluggable task store with an ATOMIC claim.
 *
 * claim() is the critical section: exactly one caller may win a task.
 * Two implementations share one interface so the protocol is testable
 * without a live database:
 *
 *   - makeMemoryStore() : in-process, emulates transaction isolation
 *   - pgClaimSQL()      : the real Postgres statement (SKIP LOCKED)
 *
 * Lease semantics give at-least-once delivery and crash recovery: if a
 * worker dies mid-task, its lease expires and another worker may claim it.
 */

export const DEFAULTS = { leaseMs: 60_000, maxAttempts: 3, retryBaseMs: 5_000 };

export function makeMemoryStore({
  tasks = [], leaseMs = DEFAULTS.leaseMs, retryBaseMs = DEFAULTS.retryBaseMs,
} = {}) {
  const rows = new Map();
  for (const t of tasks) {
    rows.set(t.taskId, {
      ...t, kind: t.kind ?? 'echo', state: 'pending', nodeId: null, claimedAt: null, attempts: 0,
      result: null, nextAttemptAt: 0,
    });
  }
  // Serialises claim() to emulate a DB transaction. Real atomicity comes from
  // the DB (FOR UPDATE SKIP LOCKED / unique constraint), not from this flag.
  let held = false;
  const queue = [];
  const lock = async () => {
    while (held) await new Promise((r) => queue.push(r));
    held = true;
  };
  const unlock = () => { held = false; const n = queue.shift(); if (n) n(); };

  /**
   * A row is claimable when it is new, OR its lease lapsed (worker died),
   * OR it failed and its backoff has elapsed and it still has attempts left.
   * The backoff is what stops a poison task from being retried in a hot loop.
   */
  const eligible = (r, now) =>
    r.state === 'pending' ||
    (r.state === 'claimed' && now - r.claimedAt > leaseMs) ||
    (r.state === 'failed' && r.attempts < DEFAULTS.maxAttempts && (r.nextAttemptAt ?? 0) <= now);

  const backoffFor = (attempts) => retryBaseMs * 2 ** Math.max(0, attempts - 1);

  return {
    kind: 'memory',
    eligible, backoffFor,

    async enqueue(task) {
      const taskId = task.taskId ?? `t-${Math.random().toString(36).slice(2, 10)}`;
      rows.set(taskId, {
        taskId, title: task.title ?? '(untitled)', kind: task.kind ?? 'echo',
        payload: task.payload ?? null,
        createdAt: task.createdAt ?? new Date().toISOString(),
        state: 'pending', nodeId: null, claimedAt: null, attempts: 0,
        result: null, nextAttemptAt: 0,
      });
      return taskId;
    },

    async claim({ nodeId, now = Date.now(), lease = leaseMs }) {
      await lock();
      try {
        const candidate = [...rows.values()]
          .filter((r) => eligible(r, now))
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
        if (!candidate) return null;
        candidate.state = 'claimed';
        candidate.nodeId = nodeId;
        candidate.claimedAt = now;
        candidate.attempts += 1;
        return { ...candidate };
      } finally { unlock(); }
    },

    async complete(taskId, result) {
      const r = rows.get(taskId);
      if (!r) return false;
      r.state = 'done'; r.result = result; r.completedAt = new Date().toISOString();
      return true;
    },

    async fail(taskId, error, now = Date.now()) {
      const r = rows.get(taskId);
      if (!r) return false;
      r.error = String(error?.message ?? error);
      r.nodeId = null; r.claimedAt = null;
      if (r.attempts >= DEFAULTS.maxAttempts) {
        r.state = 'dead';                       // poison: stop retrying
      } else {
        r.state = 'failed';
        r.nextAttemptAt = now + backoffFor(r.attempts);
      }
      return true;
    },

    /** Return a task to the queue from scratch - the operator "try again". */
    async requeue(taskId) {
      const r = rows.get(taskId);
      if (!r) return false;
      r.state = 'pending'; r.nodeId = null; r.claimedAt = null;
      r.attempts = 0; r.result = null; r.error = null; r.nextAttemptAt = 0;
      return true;
    },

    snapshot() { return [...rows.values()].map((r) => ({ ...r })); },
  };
}

/** The real thing: atomic claim in one statement, no read-then-write race. */
export function pgClaimSQL() {
  return `
UPDATE swarm_tasks
   SET state = 'claimed',
       node_id = $1,
       claimed_at = now(),
       attempts = attempts + 1
 WHERE id = (
   SELECT id FROM swarm_tasks
    WHERE state = 'pending'
       OR (state = 'claimed' AND claimed_at < now() - ($2 || ' milliseconds')::interval)
       OR (state = 'failed'  AND attempts < $3)
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
 )
RETURNING *;`;
}
