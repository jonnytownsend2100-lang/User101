import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoryStore } from '../../vercel-node/lib/claim.js';
import { makeMemoryRegistry } from '../../vercel-node/lib/registry.js';
import { handlers } from '../lib/handlers.mjs';
import { createNodePool } from '../lib/nodes.mjs';

const FAST = { pollMs: 1, idlePollMs: 1, heartbeatMs: 100_000 };

async function waitFor(predicate, { timeout = 5_000, interval = 5 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeout) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const seeded = (n, kind = 'add') => makeMemoryStore({
  tasks: Array.from({ length: n }, (_, i) => ({
    taskId: `t${i}`, title: `job ${i}`, kind, payload: { a: i, b: i },
  })),
});

test('pool: three nodes drain one queue with no double-processing', async () => {
  const store = seeded(12);
  const registry = makeMemoryRegistry();
  const pool = createNodePool({ store, registry, handlers, ...FAST });

  try {
    await pool.setCount(3);
    await waitFor(() => store.snapshot().every((t) => t.state === 'done'));

    const rows = store.snapshot();
    assert.equal(rows.filter((t) => t.state === 'done').length, 12);
    assert.deepEqual([...new Set(rows.map((t) => t.attempts))], [1], 'every task claimed exactly once');
    assert.equal(pool.list().reduce((sum, n) => sum + n.processed, 0), 12, 'node counters agree');
    assert.equal(pool.running, 3);
  } finally {
    await pool.stopAll();
  }
});

test('pool: work is shared, not all taken by one node', async () => {
  const store = seeded(20);
  const pool = createNodePool({ store, registry: makeMemoryRegistry(), handlers, ...FAST });
  try {
    await pool.setCount(4);
    await waitFor(() => store.snapshot().every((t) => t.state === 'done'));
    const active = pool.list().filter((n) => n.processed > 0);
    assert.ok(active.length >= 2, `expected several nodes to work, got ${active.length}`);
  } finally {
    await pool.stopAll();
  }
});

test('pool: a flaky task is retried with backoff and eventually succeeds', async () => {
  const store = makeMemoryStore({
    retryBaseMs: 5,
    tasks: [{ taskId: 'f', title: 'flaky', kind: 'flaky', payload: { failFirst: 2 } }],
  });
  const pool = createNodePool({ store, registry: makeMemoryRegistry(), handlers, ...FAST });
  try {
    await pool.setCount(1);
    await waitFor(() => store.snapshot()[0].state === 'done', { timeout: 4_000 });
    assert.equal(store.snapshot()[0].attempts, 3, 'two failures then a success');
    assert.equal(pool.list()[0].failed, 2, 'the node reports the failures it saw');
  } finally {
    await pool.stopAll();
  }
});

test('pool: an always-failing task dead-letters instead of retrying forever', async () => {
  const store = makeMemoryStore({
    retryBaseMs: 1,
    tasks: [{ taskId: 'd', title: 'doomed', kind: 'flaky', payload: { failFirst: 99 } }],
  });
  const pool = createNodePool({ store, registry: makeMemoryRegistry(), handlers, ...FAST });
  try {
    await pool.setCount(1);
    await waitFor(() => store.snapshot()[0].state === 'dead', { timeout: 4_000 });
    assert.equal(store.snapshot()[0].attempts, 3, 'stops at maxAttempts');
  } finally {
    await pool.stopAll();
  }
});

test('pool: stopping a node retires it from the registry immediately', async () => {
  const store = makeMemoryStore();
  const registry = makeMemoryRegistry();
  const pool = createNodePool({ store, registry, handlers, ...FAST });

  try {
    await pool.setCount(2);
    await waitFor(async () => (await registry.list()).length === 2);

    await pool.setCount(0);
    assert.equal(pool.running, 0);
    await waitFor(async () => (await registry.list()).length === 0);
    assert.equal(pool.list().every((n) => n.status === 'stopped'), true);
  } finally {
    await pool.stopAll();
  }
});

test('pool: scaling is clamped and reuses node identities', async () => {
  const pool = createNodePool({ store: makeMemoryStore(), registry: makeMemoryRegistry(), handlers, ...FAST });
  try {
    const first = await pool.setCount(2);
    const ids = first.map((n) => n.nodeId);
    assert.equal(ids.length, 2);

    await pool.setCount(0);
    const again = await pool.setCount(2);
    assert.deepEqual(again.map((n) => n.nodeId), ids, 'same node ids are recycled');

    await pool.setCount(1_000);
    assert.equal(pool.running, 32, 'clamped to MAX_NODES');
  } finally {
    await pool.stopAll();
  }
});
