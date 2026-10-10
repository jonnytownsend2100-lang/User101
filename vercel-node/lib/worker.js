/**
 * Worker loop: claim -> execute -> complete|fail, with a wall-clock budget.
 *
 * The budget matters because Vercel caps function duration (Hobby 300s hard,
 * Pro 800s / 1800s extended). We stop claiming before the cap so we always
 * get to write our terminal state rather than being killed mid-task.
 */

export const SAFETY_MARGIN_MS = 20_000;

export function makeExecutor({ handlers = {}, defaultHandler } = {}) {
  return async function execute(task, ctx = {}) {
    const fn = handlers[task.kind] ?? defaultHandler ?? (async (t) => ({ ok: true, echo: t.taskId }));
    return fn(task, ctx);
  };
}

/**
 * Drain at most `max` tasks, stopping when the deadline nears.
 * Returns a summary suitable for logging / a cron response body.
 */
export async function drainOnce(store, { nodeId, execute, max = 5, budgetMs = 240_000, now = () => Date.now() }) {
  const started = now();
  const deadline = started + budgetMs - SAFETY_MARGIN_MS;
  const done = [];
  const errors = [];

  for (let i = 0; i < max; i++) {
    if (now() >= deadline) { errors.push({ reason: 'budget-exhausted' }); break; }

    const task = await store.claim({ nodeId, now: now() });
    if (!task) break;                       // nothing to do

    try {
      const result = await execute(task, { nodeId });
      await store.complete(task.taskId, result);
      done.push({ taskId: task.taskId, attempts: task.attempts });
    } catch (err) {
      await store.fail(task.taskId, err, now());
      errors.push({ taskId: task.taskId, error: String(err?.message ?? err) });
    }
  }

  return { nodeId, claimed: done.length, failed: errors.length, done, errors, elapsedMs: now() - started };
}
