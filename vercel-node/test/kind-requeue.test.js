import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoryStore } from '../lib/claim.js';
import { makeMemoryRegistry } from '../lib/registry.js';
import { makeExecutor } from '../lib/worker.js';
import { handlers } from '../lib/handlers.js';

/**
 * Regression cover for three gaps found while building the console app:
 *   - `kind` was dropped by the store, so handlers[kind] routing never resolved;
 *   - there was no way to retry a dead-lettered task;
 *   - a stopped node lingered as "alive" until its heartbeat went stale.
 */

test('enqueue: persists `kind` so handler routing works end to end', async () => {
  const store = makeMemoryStore();
  await store.enqueue({ title: 'sum', kind: 'add', payload: { a: 2, b: 3 } });

  const task = await store.claim({ nodeId: 'n1' });
  assert.equal(task.kind, 'add');

  const execute = makeExecutor({ handlers });
  assert.deepEqual(await execute(task, { nodeId: 'n1' }), { ok: true, sum: 5 });
});

test('enqueue: defaults kind to echo when omitted', async () => {
  const store = makeMemoryStore();
  await store.enqueue({ title: 'no kind' });
  assert.equal((await store.claim({ nodeId: 'n' })).kind, 'echo');
});

test('seeded tasks keep an explicit kind and default when absent', async () => {
  const store = makeMemoryStore({
    tasks: [
      { taskId: 'a', title: 'a', kind: 'add' },
      { taskId: 'b', title: 'b' },
    ],
  });
  const byId = Object.fromEntries(store.snapshot().map((r) => [r.taskId, r.kind]));
  assert.deepEqual(byId, { a: 'add', b: 'echo' });
});

test('requeue: a dead task becomes claimable again with a fresh attempt budget', async () => {
  const store = makeMemoryStore({ leaseMs: 1, retryBaseMs: 1, tasks: [{ taskId: 'boom', title: 'poison' }] });

  let now = 1000;
  for (let i = 0; i < 3; i++) {
    const task = await store.claim({ nodeId: 'a', now, lease: 1 });
    await store.fail(task.taskId, new Error('nope'), now);
    now += 1000;
  }
  assert.equal(store.snapshot()[0].state, 'dead', 'exhausted attempts -> dead-letter');
  assert.equal(await store.claim({ nodeId: 'a', now }), null, 'dead tasks are not retried');

  assert.equal(await store.requeue('boom'), true);

  const row = store.snapshot()[0];
  assert.equal(row.state, 'pending');
  assert.equal(row.attempts, 0, 'attempt budget is restored');
  assert.equal(row.error, null);
  assert.equal(row.nodeId, null);

  const again = await store.claim({ nodeId: 'b', now: now + 1 });
  assert.equal(again.nodeId, 'b');
  assert.equal(again.attempts, 1);
});

test('requeue: an unknown task id returns false', async () => {
  assert.equal(await makeMemoryStore().requeue('nope'), false);
});

test('registry.retire: removes a node immediately instead of waiting for staleness', async () => {
  const registry = makeMemoryRegistry();
  await registry.heartbeat({ nodeId: 'w1' });
  assert.equal((await registry.list()).length, 1);

  assert.equal(await registry.retire('w1'), true);
  assert.equal((await registry.list()).length, 0);
  assert.equal(await registry.retire('w1'), false, 'second retire is a no-op');
});
