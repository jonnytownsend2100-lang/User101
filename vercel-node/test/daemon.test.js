import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, createDaemon } from '../daemon.mjs';
import { makeMemoryTransport } from '../lib/transport.js';

const msg = (id, extra = {}) => ({ messageId: id, taskId: id, title: `task ${id}`, ...extra });
const quiet = { log() {}, error() {} };

test('tick: acks every message and reports a summary', async () => {
  const transport = makeMemoryTransport({ messages: [msg('a'), msg('b'), msg('c')] });
  const out = await tick({ transport, execute: async (m) => ({ ok: m.taskId }), nodeId: 'n1', logger: quiet });

  assert.equal(out.received, 3);
  assert.equal(out.acked, 3);
  assert.equal(out.failed, 0);
  assert.deepEqual(transport.calls.acks.map((a) => a.id).sort(), ['a', 'b', 'c']);
  assert.equal(transport.calls.acks[0].result.ok, 'a');
});

test('tick: one poison message does not abort the batch', async () => {
  const transport = makeMemoryTransport({ messages: [msg('good1'), msg('poison'), msg('good2')] });
  const out = await tick({
    transport,
    execute: async (m) => { if (m.taskId === 'poison') throw new Error('kaboom'); return { ok: true }; },
    nodeId: 'n1', concurrency: 1, logger: quiet,
  });

  assert.equal(out.acked, 2);
  assert.equal(out.failed, 1);
  assert.equal(out.errors[0].taskId, 'poison');
  assert.deepEqual(transport.calls.fails.map((f) => f.id), ['poison']);
  assert.equal(transport.calls.acks.length, 2);
});

test('tick: empty poll is a clean no-op and still asks for work', async () => {
  const transport = makeMemoryTransport({ messages: [] });
  const out = await tick({ transport, execute: async () => ({}), nodeId: 'n1', logger: quiet });
  assert.equal(out.received, 0);
  assert.equal(transport.calls.receives, 1);
});

test('tick: passes limit and visibility through to the transport', async () => {
  const transport = makeMemoryTransport({ messages: [] });
  await tick({ transport, execute: async () => ({}), nodeId: 'n1', limit: 7, visibilityMs: 12_345, logger: quiet });
  assert.equal(transport.calls.lastReceiveOpts.limit, 7);
  assert.equal(transport.calls.lastReceiveOpts.visibilityMs, 12_345);
});

test('tick: concurrency never exceeds the batch size', async () => {
  const transport = makeMemoryTransport({ messages: [msg('only')] });
  let peak = 0; let live = 0;
  await tick({
    transport, nodeId: 'n1', concurrency: 8, logger: quiet,
    execute: async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return {}; },
  });
  assert.equal(peak, 1, 'one message can only occupy one worker');
});

test('tick: a failing fail-report is recorded, not thrown', async () => {
  const transport = makeMemoryTransport({ messages: [msg('p')] });
  transport.fail = async () => { throw new Error('broker down'); };
  const out = await tick({
    transport, nodeId: 'n1', logger: quiet,
    execute: async () => { throw new Error('task failed'); },
  });
  assert.equal(out.failed, 1);
  assert.ok(out.errors.some((e) => e.error.includes('fail-report failed')));
});

test('tick: a broken transport propagates so the loop can back off', async () => {
  const transport = makeMemoryTransport({ failReceive: true });
  await assert.rejects(() => tick({ transport, execute: async () => ({}), logger: quiet }), /receive exploded/);
});

test('createDaemon: runs a bounded number of cycles and heartbeats', async () => {
  const transport = makeMemoryTransport({ messages: [] });
  const daemon = createDaemon({
    transport, execute: async () => ({}), nodeId: 'nd', maxCycles: 2,
    idlePollMs: 1, pollMs: 1, heartbeatMs: 100_000, logger: quiet,
  });
  await daemon.loop();
  assert.equal(daemon.cycles, 2);
  assert.equal(daemon.running, false);
  assert.ok(transport.calls.heartbeats.length >= 1, 'heartbeats on start');
  assert.equal(transport.calls.heartbeats[0].nodeId, 'nd');
});

test('createDaemon: keeps going after a transport error instead of dying', async () => {
  const transport = makeMemoryTransport({ messages: [msg('x')] });
  let calls = 0;
  const realReceive = transport.receive;
  transport.receive = async (o) => {
    calls += 1;
    if (calls === 1) throw new Error('transient network');
    return realReceive(o);
  };
  const daemon = createDaemon({
    transport, execute: async () => ({ ok: true }), nodeId: 'nd', maxCycles: 2,
    idlePollMs: 1, pollMs: 1, heartbeatMs: 100_000, logger: quiet,
  });
  await daemon.loop();
  // 3 receive attempts were made, but only 2 successful cycles counted:
  // the throwing cycle is skipped and the loop still reaches its cap.
  assert.equal(calls, 3, 'attempted another poll after the error');
  assert.equal(daemon.cycles, 2, 'only successful cycles are counted');
  assert.equal(transport.calls.acks.length, 1, 'work still got done afterwards');
});
