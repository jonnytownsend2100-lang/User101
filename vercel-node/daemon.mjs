#!/usr/bin/env node
/**
 * Swarm compute node daemon.
 *
 * Polls a transport for work, executes it with bounded concurrency, acks or
 * fails each message, and heartbeats so the controller can see it is alive.
 *
 * This is the piece that makes the node a COMPUTE NODE rather than a single
 * request handler: it runs as a long-lived process (sandbox, VPS, on-prem, or
 * another cloud) while Vercel stays the scheduler and message layer.
 */
import { makeExecutor } from './lib/worker.js';
import { handlers } from './lib/handlers.js';
import { makeHttpPollTransport } from './lib/transport.js';

export const NODE_ID =
  process.env.SWARM_NODE_ID || `worker-${(process.env.HOSTNAME || 'local').slice(0, 10)}-${process.pid}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One poll cycle. Returns a summary; safe to call repeatedly.
 * Failures are per-message: one poison task never aborts the batch.
 */
export async function tick({
  transport, execute, nodeId = NODE_ID, limit = 5, concurrency = 2,
  visibilityMs = 60_000, logger = console,
} = {}) {
  const started = Date.now();
  const messages = await transport.receive({ limit, visibilityMs });
  const summary = { nodeId, received: messages.length, acked: 0, failed: 0, errors: [] };
  if (!messages.length) return { ...summary, elapsedMs: Date.now() - started };

  const queue = [...messages];
  const worker = async () => {
    for (;;) {
      const msg = queue.shift();
      if (!msg) return;
      try {
        const result = await execute(msg, { nodeId, attempt: msg.attempts ?? 1 });
        await transport.ack(msg.messageId, result);
        summary.acked += 1;
      } catch (err) {
        logger.error?.(`[${nodeId}] task ${msg.taskId} failed:`, err?.message ?? err);
        try { await transport.fail(msg.messageId, err); } catch (e) {
          summary.errors.push({ taskId: msg.taskId, error: `fail-report failed: ${e.message}` });
        }
        summary.failed += 1;
        summary.errors.push({ taskId: msg.taskId, error: String(err?.message ?? err) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, messages.length)) }, worker));
  return { ...summary, elapsedMs: Date.now() - started };
}

/** Long-running loop with heartbeat and graceful shutdown. */
export function createDaemon({
  transport, execute = makeExecutor({ handlers }), nodeId = NODE_ID, limit = 5,
  concurrency = 2, pollMs = 2_000, idlePollMs = 5_000, heartbeatMs = 30_000,
  maxCycles = Infinity, logger = console,
} = {}) {
  let running = false;
  let stopping = false;
  let cycles = 0;

  const beat = () => transport.heartbeat?.(nodeId, { pid: process.pid, host: process.env.HOSTNAME ?? null })
    .catch((e) => logger.error?.(`[${nodeId}] heartbeat failed:`, e.message));

  async function loop() {
    running = true;
    await beat();
    const hb = setInterval(beat, heartbeatMs);
    try {
      while (!stopping && cycles < maxCycles) {
        let out;
        try {
          out = await tick({ transport, execute, nodeId, limit, concurrency, logger });
        } catch (err) {
          logger.error?.(`[${nodeId}] poll failed:`, err?.message ?? err);
          await sleep(idlePollMs);
          continue;
        }
        cycles += 1;
        logger.log?.(`[${nodeId}] cycle ${cycles}: received=${out.received} acked=${out.acked} failed=${out.failed}`);
        if (out.received === 0) await sleep(idlePollMs);
        else if (!stopping) await sleep(pollMs);
      }
    } finally {
      clearInterval(hb);
      running = false;
      logger.log?.(`[${nodeId}] stopped after ${cycles} cycle(s)`);
    }
  }

  const onSignal = () => { stopping = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return { loop, stop() { stopping = true; }, get cycles() { return cycles; }, get running() { return running; } };
}

// ---------- cli ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.env.SWARM_BASE_URL;
  if (!baseUrl) {
    console.error('SWARM_BASE_URL is required, e.g. https://my-swarm.vercel.app');
    process.exit(1);
  }
  const transport = makeHttpPollTransport({ baseUrl, apiKey: process.env.SWARM_API_KEY ?? null });
  const daemon = createDaemon({
    transport,
    limit: Number(process.env.SWARM_LIMIT || 5),
    concurrency: Number(process.env.SWARM_CONCURRENCY || 2),
  });
  daemon.loop().catch((e) => { console.error(e); process.exit(1); });
}
