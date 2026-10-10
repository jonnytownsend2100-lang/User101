import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoryStore } from '../lib/claim.js';
import { createHandler } from '../api/worker.js';

/** Minimal req/res doubles so the real handler can be exercised end-to-end. */
function mockRes() {
  const out = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  return out;
}

async function seeded(tasks) {
  const store = makeMemoryStore({ tasks });
  return store;
}

test('endpoint: drains a queue and returns a summary', async () => {
  const store = await seeded([
    { taskId: 'a', title: 'first' },
    { taskId: 'b', title: 'second' },
  ]);
  const handler = createHandler({ storeFactory: async () => store });

  const res = mockRes();
  await handler({ method: 'GET', headers: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.claimed, 2);
  assert.equal(store.snapshot().filter((r) => r.state === 'done').length, 2);
});

test('endpoint: empty queue still returns 200 with zero work', async () => {
  const handler = createHandler({ storeFactory: async () => makeMemoryStore() });
  const res = mockRes();
  await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.claimed, 0);
});

test('endpoint: rejects an unauthenticated cron call when CRON_SECRET is set', async () => {
  process.env.CRON_SECRET = 's3cret';
  try {
    const handler = createHandler({ storeFactory: async () => makeMemoryStore() });
    const res = mockRes();
    await handler({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 401);
  } finally { delete process.env.CRON_SECRET; }
});

test('endpoint: accepts the correct cron bearer token', async () => {
  process.env.CRON_SECRET = 's3cret';
  try {
    const handler = createHandler({ storeFactory: async () => makeMemoryStore() });
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer s3cret' } }, res);
    assert.equal(res.statusCode, 200);
  } finally { delete process.env.CRON_SECRET; }
});

test('endpoint: a throwing handler yields 200 with a recorded failure, not a 500', async () => {
  const store = await seeded([{ taskId: 'x', title: 'bad' }]);
  const handler = createHandler({
    storeFactory: async () => store,
    executor: async () => { throw new Error('handler exploded'); },
  });
  const res = mockRes();
  await handler({ method: 'GET', headers: {} }, res);

  // The task failed, but the invocation itself succeeded - important so cron
  // does not retry the whole batch because one task was poison.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.failed, 1);
  assert.equal(store.snapshot()[0].state, 'failed');
});
