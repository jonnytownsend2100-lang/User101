/**
 * Task handlers, keyed by `kind`. This is the only file you edit to give the
 * swarm real work. Each handler receives (task, ctx) and returns JSON.
 */

export const handlers = {
  /** Trivial proof-of-life handler used by tests and smoke checks. */
  async echo(task) {
    return { ok: true, echoed: task.title, at: new Date().toISOString() };
  },

  /** Sum numbers - shows real computation happening inside the node. */
  async add(task) {
    const { a = 0, b = 0 } = task.payload ?? {};
    return { ok: true, sum: Number(a) + Number(b) };
  },

  /**
   * Clone a repo into this invocation's scratch dir and run a command.
   * NOTE: functions are stateless - the clone is thrown away each run.
   * Enable deliberately; untrusted code belongs in Vercel Sandbox, not here.
   */
  async repoTick(task, ctx) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const repo = task.payload?.repo;
    if (!repo) throw new Error('payload.repo is required');
    const dir = `/tmp/${ctx.nodeId}-${task.taskId}`;
    await run('git', ['clone', '--depth', '1', repo, dir]);
    const { stdout } = await run('git', ['-C', dir, 'rev-parse', 'HEAD']);
    return { ok: true, repo, head: stdout.trim() };
  },
};
