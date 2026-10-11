import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../server.mjs';

async function start(overrides = {}) {
  const app = createConsole({ autoStart: false, pushMs: 20, ...overrides });
  const { url } = await app.listen(0);
  return { app, url, close: () => app.close() };
}

const post = (url, path, body) =>
  fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const getState = async (url) => (await fetch(url + '/api/state')).json();

async function waitFor(predicate, { timeout = 10_000, interval = 15 } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeout) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

test('GET /api/state returns config, stats and an empty board', async () => {
  const { url, close } = await start();
  try {
    const state = await getState(url);
    assert.equal(state.config.store, 'memory');
    assert.equal(state.config.registry, 'memory');
    assert.ok(state.config.handlers.includes('primes'));
    assert.equal(state.stats.total, 0);
    assert.deepEqual(state.tasks, []);
    assert.deepEqual(state.nodes, []);
    assert.ok(Array.isArray(state.events));
  } finally {
    await close();
  }
});

test('POST /api/tasks validates its input', async () => {
  const { url, close } = await start();
  try {
    assert.equal((await post(url, '/api/tasks', {})).status, 400, 'title is required');
    assert.equal((await post(url, '/api/tasks', { title: 'x', kind: 'nope' })).status, 400, 'unknown kind');

    const ok = await post(url, '/api/tasks', { title: 'hi', kind: 'add', payload: { a: 1, b: 2 } });
    assert.equal(ok.status, 201);
    assert.ok((await ok.json()).taskId);
  } finally {
    await close();
  }
});

test('end-to-end: a submitted task is claimed, executed and completed', async () => {
  const { url, close } = await start();
  try {
    await post(url, '/api/nodes', { count: 2 });
    await post(url, '/api/tasks', { title: 'sum', kind: 'add', payload: { a: 20, b: 22 } });

    await waitFor(async () => (await getState(url)).tasks[0]?.state === 'done');

    const state = await getState(url);
    assert.deepEqual(state.tasks[0].result, { ok: true, a: 20, b: 22, sum: 42 });
    assert.ok(state.tasks[0].nodeId, 'the result records which node did the work');
    assert.equal(state.stats.done, 1);
  } finally {
    await close();
  }
});

test('end-to-end: the demo batch all completes, and the flaky pair retried', async () => {
  const { url, close } = await start();
  try {
    await post(url, '/api/nodes', { count: 3 });
    const seeded = await (await post(url, '/api/demo', {})).json();
    assert.equal(seeded.count, 14);

    await waitFor(async () => {
      const { stats } = await getState(url);
      return stats.total === 14 && stats.done + stats.dead === 14;
    });

    const { stats } = await getState(url);
    assert.equal(stats.done, 14);
    assert.equal(stats.dead, 0);
    assert.equal(stats.retries, 2, 'each flaky task retried exactly once');
    assert.equal(stats.successRate, 1);
  } finally {
    await close();
  }
});

test('POST /api/burst enqueues a bounded batch', async () => {
  const { url, close } = await start();
  try {
    const { count } = await (await post(url, '/api/burst', { count: 5 })).json();
    assert.equal(count, 5);
    assert.equal((await getState(url)).stats.total, 5);

    const clamped = await (await post(url, '/api/burst', { count: 99_999 })).json();
    assert.equal(clamped.count, 500, 'clamped to the maximum batch');
  } finally {
    await close();
  }
});

test('POST /api/tasks/:id/requeue revives a dead-lettered task', async () => {
  const { app, url, close } = await start({ retryBaseMs: 1 });
  try {
    const taskId = await app.enqueue({ title: 'doomed', kind: 'flaky', payload: { failFirst: 99 } });

    // Drive it to dead-letter with a virtual clock so the retry backoff is not
    // a race in the test.
    let clock = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const claimed = await app.store.claim({ nodeId: 'driver', now: clock });
      await app.store.fail(claimed.taskId, new Error('nope'), clock);
      clock += 1_000;
    }
    assert.equal(app.store.snapshot()[0].state, 'dead');

    const res = await post(url, `/api/tasks/${taskId}/requeue`, {});
    assert.equal(res.status, 200);

    const row = app.store.snapshot()[0];
    assert.equal(row.state, 'pending');
    assert.equal(row.attempts, 0);

    assert.equal((await post(url, '/api/tasks/nope/requeue', {})).status, 404);
  } finally {
    await close();
  }
});

test('the node pool is controllable over HTTP', async () => {
  const { app, url, close } = await start();
  try {
    const scaled = await (await post(url, '/api/nodes', { count: 2 })).json();
    assert.equal(scaled.nodes.filter((n) => n.status === 'running').length, 2);

    const { nodeId } = scaled.nodes[0];
    assert.equal((await post(url, `/api/nodes/${nodeId}/stop`, {})).status, 200);
    await waitFor(() => app.pool.list().filter((n) => n.status === 'running').length === 1);

    assert.equal((await post(url, '/api/nodes/nope/stop', {})).status, 404);
    assert.equal((await post(url, '/api/nodes', { count: 'abc' })).status, 400);
  } finally {
    await close();
  }
});

test('routing errors are explicit rather than silent', async () => {
  const { url, close } = await start();
  try {
    assert.equal((await fetch(url + '/api/nope')).status, 404);
    assert.equal((await fetch(url + '/api/tasks')).status, 404, 'GET on a POST route');

    const badJson = await fetch(url + '/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
    });
    assert.equal(badJson.status, 400);

    const health = await (await fetch(url + '/api/health')).json();
    assert.equal(health.ok, true);
  } finally {
    await close();
  }
});

test('serves the UI and refuses to escape the public directory', async () => {
  const { url, close } = await start();
  try {
    const res = await fetch(url + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);

    const html = await res.text();
    assert.match(html, /Swarm Console/);
    assert.match(html, /\/app\.js/);

    assert.equal((await fetch(url + '/styles.css')).status, 200);
    assert.equal((await fetch(url + '/app.js')).status, 200);
    assert.equal((await fetch(url + '/nope.txt')).status, 404);
    assert.equal((await fetch(url + '/..%2f..%2fserver.mjs')).status, 404, 'encoded traversal is contained');
    assert.equal((await fetch(url + '/%2e%2e%2fpackage.json')).status, 404);
  } finally {
    await close();
  }
});

test('the SSE stream sends an initial snapshot, then pushes changes', async () => {
  const { url, close } = await start({ pushMs: 20 });
  const controller = new AbortController();
  const bail = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(url + '/api/stream', { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value, { stream: true });
    assert.match(first, /event: state/);
    assert.match(first, /"stats"/);

    await post(url, '/api/tasks', { title: 'from sse', kind: 'echo' });

    let text = '';
    for (let i = 0; i < 8 && !text.includes('from sse'); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    assert.match(text, /from sse/, 'the submission is pushed to connected clients');

    await reader.cancel().catch(() => {});
  } finally {
    clearTimeout(bail);
    controller.abort();
    await close();
  }
});

