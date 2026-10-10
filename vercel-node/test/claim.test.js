import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoryStore, DEFAULTS } from '../lib/claim.js';
import { drainOnce } from '../lib/worker.js';

const mk = (n) => makeMemoryStore({
  tasks: Array.from({ length: n }, (_, i) => ({
    taskId: `t${i}`, title: `task ${i}`,
    createdAt: new Date(2020, 0, 1, 0, 0, i).toISOString(),
  })),
});

test('claim: concurrent workers never double-claim a task', async () => {
  const store = mk(5);
  const workers = Array.from({ length: 20 }, (_, i) => `node-${i}`);

  const results = await Promise.all(
    workers.map((nodeId) => store.claim({ nodeId })),
  );

  const won = results.filter(Boolean);
  assert.equal(won.length, 5, 'exactly 5 claims for 5 tasks');
  assert.equal(new Set(won.map((t) => t.taskId)).size, 5, 'each task won once');
  assert.equal(
    new Set(won.map((t) => t.nodeId)).size, 5,
    'no worker claimed two tasks',
  );
});

test('claim: returns null when the queue is empty', async () => {
  const store = mk(1);
  assert.ok(await store.claim({ nodeId: 'a' }));
  assert.equal(await store.claim({ nodeId: 'b' }), null);
});

test('lease expiry: a dead worker\'s task becomes claimable again (at-least-once)', async () => {
  const store = makeMemoryStore({ leaseMs: 1000, tasks: [{ taskId: 'x', title: 'slow' }] });

  const t0 = 10_000;
  const first = await store.claim({ nodeId: 'node-a', now: t0, lease: 1000 });
  assert.equal(first.nodeId, 'node-a');

  // still leased -> nobody else may take it
  assert.equal(await store.claim({ nodeId: 'node-b', now: t0 + 500, lease: 1000 }), null);

  // lease expired -> recovered by another worker
  const second = await store.claim({ nodeId: 'node-b', now: t0 + 2000, lease: 1000 });
  assert.equal(second.nodeId, 'node-b');
  assert.equal(second.attempts, 2, 'attempt counter increments');
});

test('completed tasks are terminal: never re-claimed', async () => {
  const store = mk(1);
  const t = await store.claim({ nodeId: 'a' });
  await store.complete(t.taskId, { ok: true });
  assert.equal(await store.claim({ nodeId: 'b' }), null);
  assert.equal(store.snapshot()[0].state, 'done');
});

test('poison task: retried up to maxAttempts then marked dead', async () => {
  const store = makeMemoryStore({
    leaseMs: 1, retryBaseMs: 1, tasks: [{ taskId: 'boom', title: 'always fails' }],
  });

  let now = 1000;
  for (let i = 1; i <= DEFAULTS.maxAttempts; i++) {
    const t = await store.claim({ nodeId: 'a', now, lease: 1 });
    assert.ok(t, `attempt ${i} should claim`);
    await store.fail(t.taskId, new Error('nope'), now);
    now += 1000;                                   // past lease and backoff
  }
  const after = await store.claim({ nodeId: 'a', now: now + 10_000, lease: 1 });
  assert.equal(after, null, 'dead task is not retried');
  assert.equal(store.snapshot()[0].state, 'dead');
});

test('backoff: a failed task is NOT retried immediately (no hot loop)', async () => {
  const store = makeMemoryStore({ retryBaseMs: 5_000, tasks: [{ taskId: 'flaky', title: 'flaky' }] });

  const t0 = 100_000;
  const t = await store.claim({ nodeId: 'a', now: t0 });
  await store.fail(t.taskId, new Error('transient'), t0);

  assert.equal(store.snapshot()[0].state, 'failed');
  assert.equal(
    await store.claim({ nodeId: 'b', now: t0 + 1 }),
    null,
    'must not be re-claimable 1ms later',
  );
  const later = await store.claim({ nodeId: 'b', now: t0 + 5_001 });
  assert.equal(later?.nodeId, 'b', 'claimable once backoff elapses');
  assert.equal(later.attempts, 2);
});

test('backoff grows exponentially with attempts', () => {
  const store = makeMemoryStore({ retryBaseMs: 1_000 });
  assert.equal(store.backoffFor(1), 1_000);
  assert.equal(store.backoffFor(2), 2_000);
  assert.equal(store.backoffFor(3), 4_000);
});

test('drainOnce: stops at budget instead of overrunning the function cap', async () => {
  const store = mk(100);
  let clock = 0;
  const summary = await drainOnce(store, {
    nodeId: 'node-z',
    max: 50,
    budgetMs: 100_000,
    now: () => clock,
    execute: async () => { clock += 30_000; return { ok: true }; }, // slow task
  });

  assert.ok(summary.claimed >= 2 && summary.claimed < 50, `claimed=${summary.claimed}`);
  assert.ok(summary.errors.some((e) => e.reason === 'budget-exhausted'), 'signals budget stop');
});

test('drainOnce: a failing task does not abort the run', async () => {
  const store = mk(3);
  const summary = await drainOnce(store, {
    nodeId: 'n',
    execute: async (t) => { if (t.taskId === 't1') throw new Error('bad'); return { ok: true }; },
  });

  assert.equal(summary.claimed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.errors[0].taskId, 't1');
});

test('drainOnce: empty queue is a clean no-op', async () => {
  const summary = await drainOnce(makeMemoryStore(), { nodeId: 'n', execute: async () => ({}) });
  assert.equal(summary.claimed, 0);
  assert.equal(summary.failed, 0);
});
