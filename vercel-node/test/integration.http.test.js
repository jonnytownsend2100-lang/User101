import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeMemoryStore } from '../lib/claim.js';
import { makeMemoryRegistry } from '../lib/registry.js';
import { makeHttpPollTransport } from '../lib/transport.js';
import { tick } from '../daemon.mjs';
import { handle as inbox } from '../api/inbox.js';
import { handle as nodes } from '../api/nodes.js';

/**
 * End-to-end over REAL HTTP: a compute node polling a task source, exactly as
 * it would against a deployed Vercel project. Nothing is mocked except the
 * database, which is an in-memory store standing in for Postgres.
 */
async function startServer(store, registry) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); };

    if (url.pathname === '/api/inbox') {
      const body = await readJson(req);
      const nodeId = req.headers['x-swarm-node'] || 'external';
      return send(await inbox({
        store, method: req.method,
        query: Object.fromEntries(url.searchParams),
        body, nodeId,
      }));
    }
    if (url.pathname === '/api/nodes') {
      return send(await nodes({ registry, method: req.method, body: await readJson(req) }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function readJson(req) {
  if (req.method === 'GET') return {};
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}

test('http e2e: a node polls, executes and acks real work over the wire', async () => {
  const store = makeMemoryStore({
    tasks: Array.from({ length: 3 }, (_, i) => ({
      taskId: `t${i}`, title: `job ${i}`, createdAt: new Date(2020, 0, 1, 0, 0, i).toISOString(),
    })),
  });
  const registry = makeMemoryRegistry();
  const { server, baseUrl } = await startServer(store, registry);

  try {
    const transport = makeHttpPollTransport({ baseUrl });
    const out = await tick({
      transport,
      execute: async (m) => ({ ok: true, handled: m.taskId }),
      nodeId: 'worker-1', limit: 10, logger: { log() {}, error() {} },
    });

    assert.equal(out.received, 3);
    assert.equal(out.acked, 3);
    assert.equal(out.failed, 0);
    assert.equal(store.snapshot().filter((r) => r.state === 'done').length, 3);
  } finally {
    server.close();
  }
});

test('http e2e: two nodes share the queue without double-processing', async () => {
  const store = makeMemoryStore({
    tasks: Array.from({ length: 6 }, (_, i) => ({
      taskId: `t${i}`, title: `job ${i}`, createdAt: new Date(2020, 0, 1, 0, 0, i).toISOString(),
    })),
  });
  const registry = makeMemoryRegistry();
  const { server, baseUrl } = await startServer(store, registry);

  try {
    const seen = [];
    const mk = (id) => makeHttpPollTransport({ baseUrl, fetchImpl: (u, o) => {
      o.headers = { ...o.headers, 'x-swarm-node': id };   // identify this node
      return fetch(u, o);
    } });

    const run = (id) => tick({
      transport: mk(id),
      execute: async (m) => { seen.push(m.taskId); return { by: id }; },
      nodeId: id, limit: 6, concurrency: 3, logger: { log() {}, error() {} },
    });

    const [a, b] = await Promise.all([run('worker-a'), run('worker-b')]);
    assert.equal(a.acked + b.acked, 6, 'all six tasks processed exactly once');
    assert.equal(new Set(seen).size, 6, 'no task was processed twice');
  } finally {
    server.close();
  }
});

test('http e2e: heartbeat reaches the registry', async () => {
  const store = makeMemoryStore();
  const registry = makeMemoryRegistry();
  const { server, baseUrl } = await startServer(store, registry);

  try {
    const transport = makeHttpPollTransport({ baseUrl });
    await transport.heartbeat('worker-9', { pid: 1234 });
    const listed = await (await fetch(`${baseUrl}/api/nodes`)).json();
    assert.equal(listed.total, 1);
    assert.equal(listed.nodes[0].nodeId, 'worker-9');
    assert.equal(listed.alive, 1);
  } finally {
    server.close();
  }
});
