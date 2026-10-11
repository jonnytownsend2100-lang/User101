/**
 * Builds the snapshot the UI renders. Kept separate from the HTTP layer so it
 * can be unit-tested without a socket.
 */

const TASK_STATES = ['pending', 'claimed', 'failed', 'done', 'dead'];

function shapeTask(row) {
  return {
    taskId: row.taskId,
    title: row.title,
    kind: row.kind ?? 'echo',
    payload: row.payload ?? null,
    state: row.state,
    nodeId: row.nodeId ?? null,
    attempts: row.attempts ?? 0,
    createdAt: row.createdAt ?? null,
    claimedAt: row.claimedAt ?? null,
    completedAt: row.completedAt ?? null,
    nextAttemptAt: row.nextAttemptAt ?? null,
    result: row.result ?? null,
    error: row.error ?? null,
  };
}

export function computeStats(tasks) {
  const byState = Object.fromEntries(TASK_STATES.map((s) => [s, 0]));
  let attempts = 0;
  for (const t of tasks) {
    byState[t.state] = (byState[t.state] ?? 0) + 1;
    attempts += t.attempts ?? 0;
  }
  const terminal = byState.done + byState.dead;
  return {
    total: tasks.length,
    byState,
    queued: byState.pending,
    inFlight: byState.claimed,
    retrying: byState.failed,
    done: byState.done,
    dead: byState.dead,
    attempts,
    // Retries beyond the first attempt are the visible cost of failures.
    retries: Math.max(0, attempts - tasks.filter((t) => t.attempts > 0).length),
    successRate: terminal === 0 ? null : byState.done / terminal,
  };
}

function mergeNodes(registryNodes, poolNodes) {
  const byId = new Map();

  for (const n of registryNodes) {
    byId.set(n.nodeId, {
      nodeId: n.nodeId,
      alive: Boolean(n.alive),
      lastSeen: n.lastSeen ?? null,
      ageMs: n.ageMs ?? null,
      status: 'idle',
      processed: 0,
      failed: 0,
      cycles: 0,
      startedAt: null,
      lastActivityAt: null,
      lastError: null,
    });
  }

  for (const p of poolNodes) {
    const current = byId.get(p.nodeId) ?? {
      nodeId: p.nodeId,
      alive: false,
      lastSeen: null,
      ageMs: null,
    };
    byId.set(p.nodeId, {
      ...current,
      status: p.status,
      processed: p.processed,
      failed: p.failed,
      cycles: p.cycles,
      startedAt: p.startedAt,
      lastActivityAt: p.lastActivityAt,
      lastError: p.lastError,
    });
  }

  // Local pool nodes first (running, then stopped), then registry-only nodes.
  const rank = (n) => (n.status === 'running' ? 0 : n.status === 'stopping' ? 1 : n.alive ? 2 : 3);
  return [...byId.values()].sort((a, b) => rank(a) - rank(b) || a.nodeId.localeCompare(b.nodeId));
}

export async function buildState({ store, registry, pool, hub, config }, { includeEvents = false } = {}) {
  const tasks = store.snapshot().map(shapeTask);
  const nodes = mergeNodes(await registry.list(), pool.list());

  const state = {
    at: new Date().toISOString(),
    config,
    stats: computeStats(tasks),
    tasks: tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    nodes,
    pool: { running: pool.running },
  };
  if (includeEvents) state.events = hub.events();
  return state;
}
