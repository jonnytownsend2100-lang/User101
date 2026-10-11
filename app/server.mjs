#!/usr/bin/env node
/**
 * Swarm Console - a real-time web app for running and observing the swarm.
 *
 * It is not a mock. It wires the *actual* swarm core from `vercel-node/`:
 *
 *   store      vercel-node/lib/claim.js      makeMemoryStore    (atomic claim)
 *   registry   vercel-node/lib/registry.js   makeMemoryRegistry (liveness)
 *   executor   vercel-node/lib/worker.js     makeExecutor       (kind routing)
 *   daemon     vercel-node/daemon.mjs        tick()             (poll/ack/fail)
 *
 * ...and adds the two things the core never had: a transport backed by the
 * in-process store, and a UI.
 */
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeMemoryStore } from '../vercel-node/lib/claim.js';
import { makeMemoryRegistry } from '../vercel-node/lib/registry.js';
import { handlers, HANDLER_KINDS, PRESETS } from './lib/handlers.mjs';
import { createNodePool, MAX_NODES } from './lib/nodes.mjs';
import { createHub } from './lib/hub.mjs';
import { buildState } from './lib/state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const MAX_BODY_BYTES = 256 * 1024;

const DEMO_TASKS = [
  { kind: 'echo', title: 'Say hello', payload: {} },
  { kind: 'add', title: 'Add 21 + 21', payload: { a: 21, b: 21 } },
  { kind: 'sha256', title: 'Hash "swarm"', payload: { text: 'swarm' } },
  { kind: 'primes', title: 'Count primes below 300k', payload: { n: 300_000 } },
  { kind: 'fib', title: 'fib(70)', payload: { n: 70 } },
  { kind: 'sleep', title: 'Hold a claim for 1.5s', payload: { ms: 1500 } },
  { kind: 'flaky', title: 'Fail once, then succeed', payload: { failFirst: 1 } },
];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function createConsole({
  store = null,
  registry = makeMemoryRegistry(),
  taskHandlers = handlers,
  nodeCount = 3,
  pushMs = 350,
  autoStart = true,
  leaseMs = 60_000,
  retryBaseMs = 2_000,
  logger = console,
} = {}) {
  store = store ?? makeMemoryStore({ retryBaseMs });
  const hub = createHub();

  const config = {
    nodeCount,
    maxNodes: MAX_NODES,
    leaseMs,
    store: store.kind,
    registry: registry.kind,
    handlers: HANDLER_KINDS,
    presets: PRESETS,
    // Honest limits, surfaced in the UI rather than hidden in a README.
    note: 'Single process, in-memory store: state does not survive a restart, and "many nodes" is concurrency within one process.',
  };

  const pool = createNodePool({
    store,
    registry,
    handlers: taskHandlers,
    onEvent: (event) => hub.log(event),
    logger: { log() {}, error() {} },
  });

  const ctx = { store, registry, pool, hub, config };

  async function enqueue({ title, kind, payload } = {}) {
    const resolvedKind = kind ?? 'echo';
    if (!taskHandlers[resolvedKind]) {
      throw Object.assign(new Error(`unknown kind: ${resolvedKind}`), { status: 400 });
    }
    const cleanTitle = title?.trim() || '(untitled)';
    const taskId = await store.enqueue({ title: cleanTitle, kind: resolvedKind, payload: payload ?? null });
    hub.log({ type: 'task-submitted', taskId, title: cleanTitle, kind: resolvedKind });
    return taskId;
  }

  async function seedDemo() {
    const ids = [];
    for (const task of [...DEMO_TASKS, ...DEMO_TASKS]) ids.push(await enqueue(task));
    hub.log({ type: 'demo-seeded', count: ids.length });
    return ids;
  }

  async function burst(count) {
    const n = clamp(Math.trunc(Number(count) || 0), 1, 500);
    const kinds = ['add', 'sha256', 'primes', 'fib', 'echo', 'sleep'];
    const ids = [];
    for (let i = 0; i < n; i++) {
      const kind = kinds[i % kinds.length];
      const payload =
        kind === 'add' ? { a: i, b: i * 2 }
          : kind === 'sha256' ? { text: `task-${i}` }
            : kind === 'primes' ? { n: 20_000 + i * 500 }
              : kind === 'fib' ? { n: 20 + (i % 40) }
                : kind === 'sleep' ? { ms: 100 + (i % 5) * 120 }
                  : {};
      ids.push(await enqueue({ title: `burst #${i + 1}`, kind, payload }));
    }
    hub.log({ type: 'burst-enqueued', count: ids.length });
    return ids;
  }

  // ---- change-detecting broadcaster -------------------------------------
  let lastKey = '';
  const timer = setInterval(async () => {
    if (hub.clientCount === 0) return;
    try {
      const state = await buildState(ctx);
      const key = JSON.stringify({ ...state, at: undefined });
      if (key === lastKey) return;
      lastKey = key;
      hub.broadcastState({ ...state, at: new Date().toISOString() });
    } catch (err) {
      logger.error?.('[console] broadcast failed:', err?.message ?? err);
    }
  }, pushMs);
  timer.unref?.();

  // ---- HTTP --------------------------------------------------------------
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err?.status ?? 500;
      // A 4xx is the caller's mistake, not ours - do not cry wolf in the log.
      if (status >= 500) logger.error?.('[console] request failed:', err?.message ?? err);
      if (!res.headersSent) json(res, status, { ok: false, error: String(err?.message ?? err) });
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    if (pathname === '/api/state' && method === 'GET') {
      return json(res, 200, await buildState(ctx, { includeEvents: true }));
    }

    if (pathname === '/api/health' && method === 'GET') {
      return json(res, 200, { ok: true, clients: hub.clientCount, nodes: pool.running });
    }

    if (pathname === '/api/stream' && method === 'GET') {
      return openStream(req, res);
    }

    if (pathname === '/api/tasks' && method === 'POST') {
      const body = await readJson(req);
      if (!body.title || typeof body.title !== 'string') {
        return json(res, 400, { ok: false, error: 'title is required' });
      }
      const taskId = await enqueue(body);
      return json(res, 201, { ok: true, taskId });
    }

    const requeue = pathname.match(/^\/api\/tasks\/([^/]+)\/requeue$/);
    if (requeue && method === 'POST') {
      const taskId = decodeURIComponent(requeue[1]);
      const ok = await store.requeue(taskId);
      hub.log({ type: ok ? 'task-requeued' : 'requeue-missed', taskId });
      return json(res, ok ? 200 : 404, { ok, taskId });
    }

    if (pathname === '/api/nodes' && method === 'POST') {
      const body = await readJson(req);
      const count = Number(body.count);
      if (!Number.isFinite(count)) return json(res, 400, { ok: false, error: 'count must be a number' });
      await pool.setCount(count);
      hub.log({ type: 'pool-scaled', running: pool.running });
      return json(res, 200, { ok: true, nodes: pool.list() });
    }

    const stopNode = pathname.match(/^\/api\/nodes\/([^/]+)\/stop$/);
    if (stopNode && method === 'POST') {
      const nodeId = decodeURIComponent(stopNode[1]);
      const ok = await pool.stopById(nodeId);
      return json(res, ok ? 200 : 404, { ok, nodeId });
    }

    if (pathname === '/api/demo' && method === 'POST') {
      const taskIds = await seedDemo();
      return json(res, 201, { ok: true, count: taskIds.length, taskIds });
    }

    if (pathname === '/api/burst' && method === 'POST') {
      const body = await readJson(req);
      const taskIds = await burst(body.count ?? 25);
      return json(res, 201, { ok: true, count: taskIds.length });
    }

    return json(res, 404, { ok: false, error: `no route for ${method} ${pathname}` });
  }


  async function openStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const remove = hub.addClient(res);
    req.on('close', remove);
    res.on('close', remove);

    const state = await buildState(ctx, { includeEvents: true });
    lastKey = JSON.stringify({ ...state, at: undefined });
    try {
      res.write(`event: state\ndata: ${JSON.stringify({ ...state, at: new Date().toISOString() })}\n\n`);
    } catch { /* client vanished before the first frame */ }
  }

  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { ok: false, error: 'GET only' });
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
      return json(res, 403, { ok: false, error: 'forbidden' });
    }

    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      return json(res, 404, { ok: false, error: 'not found' });
    }
  }

  function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(data);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { status: 413 });
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('body must be valid JSON'), { status: 400 });
    }
  }

  // ---- lifecycle ---------------------------------------------------------
  const ready = autoStart ? pool.setCount(nodeCount).then(() => undefined) : Promise.resolve();

  async function listen(port = 0, host = '127.0.0.1') {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    const address = server.address();
    return { port: address.port, url: `http://${host}:${address.port}` };
  }

  async function close() {
    clearInterval(timer);
    await pool.stopAll();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  return { server, store, registry, pool, hub, config, ready, listen, close, enqueue, seedDemo, burst };
}

// ---- cli -----------------------------------------------------------------
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? argValue('--port') ?? 5173);
  const nodeCount = Number(process.env.SWARM_NODES ?? argValue('--nodes') ?? 3);
  const app = createConsole({ nodeCount });

  const { url } = await app.listen(port, process.env.HOST ?? '127.0.0.1');
  console.log(`\n  Swarm Console  ->  ${url}`);
  console.log(`  ${nodeCount} worker node(s) - store=${app.store.kind} - registry=${app.registry.kind}`);
  console.log('  Ctrl-C to stop.\n');

  const shutdown = async () => {
    console.log('\n  shutting down...');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

