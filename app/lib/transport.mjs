/**
 * Store-backed transport.
 *
 * The swarm's node contract is deliberately tiny (see
 * `vercel-node/lib/transport.js`):
 *
 *   receive({ limit, visibilityMs }) -> Message[]
 *   ack(messageId, result)           -> void
 *   fail(messageId, error)           -> void
 *   heartbeat(nodeId, meta)          -> void
 *
 * The Vercel deployment backs that contract with HTTP long-polling against
 * `/api/inbox`. The console backs the *same* contract with the in-process
 * store. Because the contract is identical, the *same* daemon loop
 * (`tick()` from `vercel-node/daemon.mjs`) drives both - which is the whole
 * point of the abstraction.
 *
 * `receive` deliberately claims one task at a time: `store.claim()` is the
 * atomic critical section, and calling it per-task keeps the lease accurate.
 */

export function makeStoreTransport({ store, registry = null, nodeId, leaseMs = 60_000, region = null, meta = {} } = {}) {
  if (!store) throw new Error('makeStoreTransport: store is required');
  if (!nodeId) throw new Error('makeStoreTransport: nodeId is required');

  return {
    kind: 'store',
    nodeId,

    async receive({ limit = 1, visibilityMs = leaseMs } = {}) {
      const out = [];
      for (let i = 0; i < limit; i++) {
        const task = await store.claim({ nodeId, lease: visibilityMs });
        if (!task) break;                        // queue drained
        out.push({
          messageId: task.taskId,
          taskId: task.taskId,
          title: task.title,
          kind: task.kind,
          payload: task.payload ?? null,
          attempts: task.attempts,
        });
      }
      return out;
    },

    async ack(messageId, result) {
      return store.complete(messageId, result);
    },

    async fail(messageId, error) {
      return store.fail(messageId, error);
    },

    async heartbeat(id = nodeId, extra = {}) {
      if (!registry) return null;
      return registry.heartbeat({ nodeId: id, region, meta: { ...meta, ...extra } });
    },
  };
}
