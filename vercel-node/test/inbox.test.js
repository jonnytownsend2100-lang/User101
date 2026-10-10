import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoryStore } from '../lib/claim.js';
import { makeMemoryRegistry } from '../lib/registry.js';
import { handle as inbox } from '../api/inbox.js';
import { handle as nodes } from '../api/nodes.js';

const seeded = (n) => makeMemoryStore({
  tasks: Array.from({ length: n }, (_, i) => ({
    taskId: `t${i}`, title: `task ${i}`, createdAt: new Date(2020, 0, 1, 0, 0, i).toISOString(),
  })),
});

test('inbox GET: leases up to limit and reports what was handed out', async () => {
  const store = seeded(5);
  const { status, body } = await inbox({ store, method: 'GET', query: { limit: 2 }, nodeId: 'w1' });

  assert.equal(status, 200);
  assert.equal(body.count, 2);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].messageId, 't0');
  assert.equal(store.snapshot().filter((r) => r.state === 'claimed').length, 2);
});

test('inbox GET: stops early when the queue runs dry', async () => {
  const { body } = await inbox({ store: seeded(1), method: 'GET', query: { limit: 10 }, nodeId: 'w1' });
  assert.equal(body.count, 1);
});

test('inbox GET: a lease hides the task from other nodes until it lapses', async () => {
  const store = seeded(1);
  await inbox({ store, method: 'GET', query: { limit: 1, visibility: 60_000 }, nodeId: 'w1' });
  const second = await inbox({ store, method: 'GET', query: { limit: 1, visibility: 60_000 }, nodeId: 'w2' });
  assert.equal(second.body.count, 0, 'w2 must not see w1’s leased task');
});

test('inbox POST ack: completes the task terminally', async () => {
  const store = seeded(1);
  await inbox({ store, method: 'GET', query: { limit: 1 }, nodeId: 'w1' });
  const { status, body } = await inbox({
    store, method: 'POST', body: { action: 'ack', messageId: 't0', result: { ok: true } },
  });

  assert.equal(status, 200);
  assert.equal(body.acked, 't0');
  assert.equal(store.snapshot()[0].state, 'done');
  assert.deepEqual(store.snapshot()[0].result, { ok: true });
});

test('inbox POST fail: schedules a retry rather than losing the task', async () => {
  const store = seeded(1);
  await inbox({ store, method: 'GET', query: { limit: 1 }, nodeId: 'w1' });
  await inbox({ store, method: 'POST', body: { action: 'fail', messageId: 't0', error: 'oops' } });

  const row = store.snapshot()[0];
  assert.equal(row.state, 'failed');
  assert.equal(row.error, 'oops');
  assert.ok(row.nextAttemptAt > 0, 'backoff scheduled');
});

test('inbox: rejects bad or missing input', async () => {
  const store = seeded(1);
  assert.equal((await inbox({ store, method: 'POST', body: {} })).status, 400);
  assert.equal((await inbox({ store, method: 'POST', body: { action: 'nope', messageId: 't0' } })).status, 400);
  assert.equal((await inbox({ store, method: 'PUT' })).status, 405);
});

test('nodes POST: heartbeat upserts a node', async () => {
  const registry = makeMemoryRegistry();
  const { status } = await nodes({ registry, method: 'POST', body: { nodeId: 'w1', region: 'iad1' } });
  assert.equal(status, 200);

  const list = await nodes({ registry, method: 'GET' });
  assert.equal(list.body.total, 1);
  assert.equal(list.body.alive, 1);
  assert.equal(list.body.nodes[0].nodeId, 'w1');
});

test('nodes: a silent node is reported stale, then reaped', async () => {
  let clock = 1_000_000;
  const registry = makeMemoryRegistry({ staleMs: 1000, now: () => clock });
  await nodes({ registry, method: 'POST', body: { nodeId: 'ghost' } });

  clock += 5_000;                                   // node stops heartbeating
  const list = await nodes({ registry, method: 'GET' });
  assert.equal(list.body.alive, 0);
  assert.equal(list.body.total, 1);

  clock += 100_000;
  const reaped = await nodes({ registry, method: 'DELETE' });
  assert.equal(reaped.body.removed, 1);
});

test('nodes POST: requires a nodeId', async () => {
  const registry = makeMemoryRegistry();
  assert.equal((await nodes({ registry, method: 'POST', body: {} })).status, 400);
});
