/**
 * Worker-node pool.
 *
 * Each node is the *real* swarm daemon: `tick()` from `vercel-node/daemon.mjs`,
 * driven by the store-backed transport. So the console is not a mock of the
 * swarm - it is the swarm, running locally, with a UI on top.
 *
 * Nodes are started/stopped at runtime so you can watch the atomic claim behave
 * under contention: N nodes, one queue, no double-processing.
 */
import { tick } from '../../vercel-node/daemon.mjs';
import { makeExecutor } from '../../vercel-node/lib/worker.js';
import { makeStoreTransport } from './transport.mjs';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { log() {}, error() {} };

export const MAX_NODES = 32;

export function createNodePool({
  store,
  registry,
  handlers,
  execute = null,
  nodePrefix = 'node',
  limit = 4,
  concurrency = 2,
  pollMs = 120,
  idlePollMs = 450,
  heartbeatMs = 5_000,
  sleep = defaultSleep,
  now = () => Date.now(),
  onEvent = () => {},
  logger = quiet,
} = {}) {
  if (!store) throw new Error('createNodePool: store is required');

  const run = execute ?? makeExecutor({ handlers });
  const nodes = new Map();
  let seq = 0;

  function spawn(name) {
    const nodeId = name ?? `${nodePrefix}-${String(++seq).padStart(2, '0')}`;
    const node = {
      nodeId,
      transport: makeStoreTransport({ store, registry, nodeId }),
      status: 'stopped',                 // stopped | running | stopping
      processed: 0,
      failed: 0,
      cycles: 0,
      startedAt: null,
      stoppedAt: null,
      lastActivityAt: null,
      lastError: null,
      stopRequested: false,
      done: null,
    };
    nodes.set(nodeId, node);
    return node;
  }

  const beat = (node) =>
    node.transport
      .heartbeat(node.nodeId, { source: 'console' })
      .catch((err) => { node.lastError = String(err?.message ?? err); });

  async function loop(node) {
    node.status = 'running';
    node.stopRequested = false;
    node.startedAt = now();
    node.lastError = null;
    await beat(node);

    const hb = setInterval(() => beat(node), heartbeatMs);
    hb.unref?.();

    try {
      while (!node.stopRequested) {
        let out;
        try {
          out = await tick({
            transport: node.transport,
            execute: run,
            nodeId: node.nodeId,
            limit,
            concurrency,
            logger,
          });
        } catch (err) {
          // A transport error must not kill the node - back off and retry.
          node.lastError = String(err?.message ?? err);
          onEvent({ type: 'node-error', nodeId: node.nodeId, error: node.lastError });
          await sleep(idlePollMs);
          continue;
        }

        node.cycles += 1;
        node.processed += out.acked;
        node.failed += out.failed;
        if (out.received > 0) {
          node.lastActivityAt = now();
          onEvent({
            type: 'node-tick',
            nodeId: node.nodeId,
            received: out.received,
            acked: out.acked,
            failed: out.failed,
          });
        }
        await sleep(out.received > 0 ? pollMs : idlePollMs);
      }
    } finally {
      clearInterval(hb);
      node.status = 'stopped';
      node.stoppedAt = now();
      try { await registry?.retire?.(node.nodeId); } catch { /* best effort */ }
      onEvent({ type: 'node-stopped', nodeId: node.nodeId, processed: node.processed, failed: node.failed });
    }
  }

  function start(node) {
    if (node.status === 'running') return node;
    node.done = loop(node).catch((err) => {
      node.lastError = String(err?.message ?? err);
      node.status = 'stopped';
    });
    return node;
  }

  async function stop(node) {
    if (node.status === 'stopped') return node;
    node.stopRequested = true;
    node.status = 'stopping';
    await node.done?.catch(() => {});
    return node;
  }

  /** Reconcile the running set to exactly `target` nodes (0..MAX_NODES). */
  async function setCount(target) {
    const wanted = Math.max(0, Math.min(MAX_NODES, Math.trunc(Number(target) || 0)));

    const running = [...nodes.values()].filter((n) => n.status !== 'stopped');
    for (const node of running.slice(wanted)) await stop(node);   // stop the newest extras

    let active = [...nodes.values()].filter((n) => n.status !== 'stopped').length;
    while (active < wanted) {
      const recycled = [...nodes.values()].find((n) => n.status === 'stopped');
      start(recycled ?? spawn());
      active += 1;
    }
    return list();
  }

  async function stopAll() {
    await Promise.all([...nodes.values()].map(stop));
  }

  function list() {
    return [...nodes.values()].map((n) => ({
      nodeId: n.nodeId,
      status: n.status,
      processed: n.processed,
      failed: n.failed,
      cycles: n.cycles,
      startedAt: n.startedAt,
      stoppedAt: n.stoppedAt,
      lastActivityAt: n.lastActivityAt,
      lastError: n.lastError,
    }));
  }

  const find = (nodeId) => nodes.get(nodeId) ?? null;

  return {
    setCount,
    stopAll,
    list,
    find,
    async stopById(nodeId) {
      const node = find(nodeId);
      if (!node) return false;
      await stop(node);
      return true;
    },
    get running() {
      return [...nodes.values()].filter((n) => n.status === 'running').length;
    },
  };
}
