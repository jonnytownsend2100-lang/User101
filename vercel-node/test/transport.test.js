import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHttpPollTransport, makeVercelQueueTransport } from '../lib/transport.js';

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const { status = 200, json = {} } = handler(url, opts) ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  impl.calls = calls;
  return impl;
}

test('http transport: receive builds the right request and maps messages', async () => {
  const fetchImpl = fakeFetch(() => ({ json: { messages: [{ messageId: 'm1', title: 'hi' }] } }));
  const t = makeHttpPollTransport({ baseUrl: 'https://x.vercel.app/', apiKey: 'k', fetchImpl });

  const out = await t.receive({ limit: 3, visibilityMs: 5000 });
  assert.equal(fetchImpl.calls[0].url, 'https://x.vercel.app/api/inbox?limit=3&visibility=5000');
  assert.equal(fetchImpl.calls[0].opts.headers['x-api-key'], 'k');
  assert.equal(out[0].messageId, 'm1');
});

test('http transport: receive returns [] when the payload omits messages', async () => {
  const t = makeHttpPollTransport({ baseUrl: 'https://x', fetchImpl: fakeFetch(() => ({ json: {} })) });
  assert.deepEqual(await t.receive(), []);
});

test('http transport: non-2xx receive throws', async () => {
  const t = makeHttpPollTransport({ baseUrl: 'https://x', fetchImpl: fakeFetch(() => ({ status: 503 })) });
  await assert.rejects(() => t.receive(), /receive failed: HTTP 503/);
});

test('http transport: ack posts action=ack with the result', async () => {
  const fetchImpl = fakeFetch(() => ({}));
  const t = makeHttpPollTransport({ baseUrl: 'https://x', fetchImpl });
  await t.ack('m9', { ok: true });
  assert.equal(fetchImpl.calls[0].url, 'https://x/api/inbox');
  assert.deepEqual(fetchImpl.calls[0].body, { action: 'ack', messageId: 'm9', result: { ok: true } });
});

test('http transport: fail posts action=fail with a stringified error', async () => {
  const fetchImpl = fakeFetch(() => ({}));
  const t = makeHttpPollTransport({ baseUrl: 'https://x', fetchImpl });
  await t.fail('m9', new Error('boom'));
  assert.deepEqual(fetchImpl.calls[0].body, { action: 'fail', messageId: 'm9', error: 'boom' });
});

test('http transport: heartbeat posts to /api/nodes', async () => {
  const fetchImpl = fakeFetch(() => ({}));
  const t = makeHttpPollTransport({ baseUrl: 'https://x', fetchImpl });
  await t.heartbeat('node-1', { pid: 42 });
  assert.equal(fetchImpl.calls[0].url, 'https://x/api/nodes');
  assert.deepEqual(fetchImpl.calls[0].body, { nodeId: 'node-1', pid: 42 });
});

test('vercel-queue transport: normalises SDK message shapes', async () => {
  const client = { receive: async () => ([{ id: 'id1', name: 'name1', body: { a: 1 } }]) };
  const t = makeVercelQueueTransport({ client });
  const [m] = await t.receive({});
  assert.equal(m.messageId, 'id1');
  assert.equal(m.taskId, 'id1');
  assert.equal(m.title, 'name1');
  assert.deepEqual(m.payload, { a: 1 });
});

test('vercel-queue transport: fails loudly when the beta client lacks a method', async () => {
  const t = makeVercelQueueTransport({ client: {} });
  await assert.rejects(() => t.receive({}), /no receive\(\) method/);
  await assert.rejects(() => t.ack('x', {}), /no ack\(\) method/);
});
