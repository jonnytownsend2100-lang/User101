import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoryStore } from '../../vercel-node/lib/claim.js';
import { makeMemoryRegistry } from '../../vercel-node/lib/registry.js';
import { makeStoreTransport } from '../lib/transport.mjs';

test('receive: claims up to limit and maps to the swarm message shape', async () => {
  const store = makeMemoryStore({
    tasks: [
      { taskId: 'a', title: 'A', kind: 'add', payload: { a: 1, b: 2 } },
      { taskId: 'b', title: 'B' },
    ],
  });
  const transport = makeStoreTransport({ store, nodeId: 'n1' });

  const messages = await transport.receive({ limit: 5 });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], {
    messageId: 'a', taskId: 'a', title: 'A', kind: 'add', payload: { a: 1, b: 2 }, attempts: 1,
  });
  assert.equal(messages[1].kind, 'echo', 'kind defaults rather than arriving undefined');
  assert.equal(await store.claim({ nodeId: 'n2' }), null, 'received tasks are leased');
});

test('receive: stops early when the queue runs dry', async () => {
  const store = makeMemoryStore({ tasks: [{ taskId: 'only', title: 'only' }] });
  const transport = makeStoreTransport({ store, nodeId: 'n1' });
  assert.equal((await transport.receive({ limit: 10 })).length, 1);
});

test('receive: an empty queue is a clean empty array', async () => {
  const transport = makeStoreTransport({ store: makeMemoryStore(), nodeId: 'n1' });
  assert.deepEqual(await transport.receive({ limit: 3 }), []);
});

test('ack completes terminally; fail schedules a backoff retry', async () => {
  const store = makeMemoryStore({
    retryBaseMs: 50,
    tasks: [{ taskId: 'a', title: 'A' }, { taskId: 'b', title: 'B' }],
  });
  const transport = makeStoreTransport({ store, nodeId: 'n1' });
  const [first, second] = await transport.receive({ limit: 2 });

  await transport.ack(first.messageId, { ok: true });
  await transport.fail(second.messageId, new Error('boom'));

  const rows = Object.fromEntries(store.snapshot().map((r) => [r.taskId, r]));
  assert.equal(rows.a.state, 'done');
  assert.deepEqual(rows.a.result, { ok: true });
  assert.equal(rows.b.state, 'failed');
  assert.equal(rows.b.error, 'boom');
  assert.ok(rows.b.nextAttemptAt > Date.now(), 'backoff is in the future');
});

test('heartbeat upserts the node into the registry', async () => {
  const registry = makeMemoryRegistry();
  const transport = makeStoreTransport({ store: makeMemoryStore(), registry, nodeId: 'n1' });

  await transport.heartbeat('n1', { source: 'test' });

  const nodes = await registry.list();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].nodeId, 'n1');
  assert.equal(nodes[0].meta.source, 'test');
});

test('construction fails loudly without a store or nodeId', () => {
  assert.throws(() => makeStoreTransport({ nodeId: 'n' }), /store is required/);
  assert.throws(() => makeStoreTransport({ store: makeMemoryStore() }), /nodeId is required/);
});
