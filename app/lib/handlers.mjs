/**
 * Task handlers, keyed by `kind`.
 *
 * These are the app's real workload. They are deliberately CPU/IO-shaped rather
 * than mocked, so the console shows genuine work moving through the queue:
 * a task sits in `claimed` for exactly as long as it takes to compute.
 *
 * The `flaky` handler is the interesting one: it fails its first N attempts on
 * purpose, so you can watch retry-with-backoff and (if you raise N) the
 * dead-letter path.
 */
import { createHash } from 'node:crypto';

const MAX_PRIME_N = 5_000_000;
const MAX_FIB_N = 90;            // beyond 90 the result exceeds Number.MAX_SAFE_INTEGER

export const handlers = {
  /** Proof of life: returns the title unchanged. */
  async echo(task) {
    return { ok: true, echoed: task.title, at: new Date().toISOString() };
  },

  /** Trivial arithmetic - the smoke-test workload. */
  async add(task) {
    const { a = 0, b = 0 } = task.payload ?? {};
    const sum = Number(a) + Number(b);
    if (!Number.isFinite(sum)) throw new Error('payload.a and payload.b must be numbers');
    return { ok: true, a: Number(a), b: Number(b), sum };
  },

  /** Real hashing work; deterministic output is easy to eyeball in the UI. */
  async sha256(task) {
    const input = String(task.payload?.text ?? task.title ?? '');
    return { ok: true, input, sha256: createHash('sha256').update(input).digest('hex') };
  },

  /** Iterative Fibonacci - burns a few CPU cycles without recursing. */
  async fib(task) {
    const n = clampInt(task.payload?.n ?? 30, 0, MAX_FIB_N, 'payload.n');
    let a = 0;
    let b = 1;
    for (let i = 0; i < n; i++) [a, b] = [b, a + b];
    return { ok: true, n, value: a };
  },

  /** Sieve of Eratosthenes - the "actual compute" task, tunable to ~50ms. */
  async primes(task) {
    const n = clampInt(task.payload?.n ?? 200_000, 2, MAX_PRIME_N, 'payload.n');
    const composite = new Uint8Array(n + 1);
    let count = 0;
    let largest = 0;
    for (let i = 2; i <= n; i++) {
      if (composite[i]) continue;
      count += 1;
      largest = i;
      for (let j = i * i; j <= n; j += i) composite[j] = 1;
    }
    return { ok: true, below: n, count, largest };
  },

  /** Holds a claim open so the "in flight" state is visible in the UI. */
  async sleep(task, ctx = {}) {
    const ms = clampInt(task.payload?.ms ?? 800, 0, 10_000, 'payload.ms');
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true, sleptMs: ms, nodeId: ctx.nodeId ?? null };
  },

  /** Fails the first `failFirst` attempts, then succeeds - shows retry + backoff. */
  async flaky(task, ctx = {}) {
    const failFirst = clampInt(task.payload?.failFirst ?? 1, 0, 10, 'payload.failFirst');
    const attempt = Number(ctx.attempt ?? 1);
    if (attempt <= failFirst) {
      throw new Error(`transient failure: attempt ${attempt} of ${failFirst + 1}`);
    }
    return { ok: true, attempts: attempt, recovered: true };
  },
};

export const HANDLER_KINDS = Object.keys(handlers);

/** Ready-made tasks the UI offers as one-click presets. */
export const PRESETS = [
  { kind: 'echo', title: 'Say hello', payload: {} },
  { kind: 'add', title: 'Add 21 + 21', payload: { a: 21, b: 21 } },
  { kind: 'sha256', title: 'Hash a string', payload: { text: 'the swarm is just git and push' } },
  { kind: 'primes', title: 'Count primes below 500k', payload: { n: 500_000 } },
  { kind: 'fib', title: 'fib(70)', payload: { n: 70 } },
  { kind: 'sleep', title: 'Hold a claim for 2s', payload: { ms: 2000 } },
  { kind: 'flaky', title: 'Fail once, then succeed', payload: { failFirst: 1 } },
];

function clampInt(value, min, max, name) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.min(max, Math.max(min, n));
}
