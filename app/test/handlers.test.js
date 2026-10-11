import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlers, HANDLER_KINDS, PRESETS } from '../lib/handlers.mjs';

test('add: sums numbers from the payload', async () => {
  assert.deepEqual(await handlers.add({ title: 'x', payload: { a: 2, b: 40 } }), { ok: true, a: 2, b: 40, sum: 42 });
});

test('add: rejects non-numeric input instead of returning NaN', async () => {
  await assert.rejects(() => handlers.add({ title: 'x', payload: { a: 'nope', b: 1 } }), /must be numbers/);
});

test('sha256: hashes deterministically', async () => {
  const first = await handlers.sha256({ title: 'x', payload: { text: 'swarm' } });
  const second = await handlers.sha256({ title: 'x', payload: { text: 'swarm' } });
  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
});

test('primes: counts primes below n', async () => {
  assert.equal((await handlers.primes({ payload: { n: 100 } })).count, 25);
  assert.equal((await handlers.primes({ payload: { n: 10 } })).largest, 7);
});

test('fib: computes the nth Fibonacci number', async () => {
  assert.equal((await handlers.fib({ payload: { n: 10 } })).value, 55);
  assert.equal((await handlers.fib({ payload: { n: 0 } })).value, 0);
});

test('fib: clamps an absurd n instead of hanging', async () => {
  assert.equal((await handlers.fib({ payload: { n: 10_000 } })).n, 90);
});

test('sleep: resolves and reports the duration', async () => {
  assert.deepEqual(await handlers.sleep({ payload: { ms: 5 } }, { nodeId: 'n1' }), { ok: true, sleptMs: 5, nodeId: 'n1' });
});

test('flaky: fails until the attempt budget is met, then succeeds', async () => {
  await assert.rejects(() => handlers.flaky({ payload: { failFirst: 2 } }, { attempt: 1 }), /transient failure/);
  await assert.rejects(() => handlers.flaky({ payload: { failFirst: 2 } }, { attempt: 2 }), /transient failure/);
  assert.deepEqual(await handlers.flaky({ payload: { failFirst: 2 } }, { attempt: 3 }), { ok: true, attempts: 3, recovered: true });
});

test('registry: every advertised kind has a handler and every preset a real kind', () => {
  for (const kind of HANDLER_KINDS) assert.equal(typeof handlers[kind], 'function', `handler for ${kind}`);
  for (const preset of PRESETS) assert.ok(HANDLER_KINDS.includes(preset.kind), `preset kind ${preset.kind}`);
});
