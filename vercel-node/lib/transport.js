/**
 * Transport layer: how a compute node receives work and reports results.
 *
 * Deliberately narrow so the node does not hard-depend on the Vercel Queues
 * beta SDK surface:
 *
 *   receive({ limit, visibilityMs }) -> Message[]
 *   ack(messageId, result)           -> void
 *   fail(messageId, error)           -> void
 *
 * Message shape: { messageId, taskId, title, kind, payload, attempts }
 */

function authHeaders(apiKey) {
  return apiKey ? { 'x-api-key': apiKey, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
}

/**
 * Polls a task source over HTTP. Works against our own /api/inbox endpoint,
 * so it runs from this sandbox, a VPS, on-prem, or any other cloud.
 */
export function makeHttpPollTransport({ baseUrl, apiKey = null, fetchImpl = globalThis.fetch }) {
  const url = (p) => `${String(baseUrl).replace(/\/+$/, '')}${p}`;

  return {
    kind: 'http-poll',
    baseUrl,

    async receive({ limit = 5, visibilityMs = 60_000 } = {}) {
      const res = await fetchImpl(
        url(`/api/inbox?limit=${limit}&visibility=${visibilityMs}`),
        { method: 'GET', headers: authHeaders(apiKey) },
      );
      if (!res.ok) throw new Error(`receive failed: HTTP ${res.status}`);
      const body = await res.json();
      return body.messages ?? [];
    },

    async ack(messageId, result) {
      const res = await fetchImpl(url('/api/inbox'), {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({ action: 'ack', messageId, result }),
      });
      if (!res.ok) throw new Error(`ack failed: HTTP ${res.status}`);
    },

    async fail(messageId, error) {
      const res = await fetchImpl(url('/api/inbox'), {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({ action: 'fail', messageId, error: String(error?.message ?? error) }),
      });
      if (!res.ok) throw new Error(`fail failed: HTTP ${res.status}`);
    },

    async heartbeat(nodeId, meta) {
      const res = await fetchImpl(url('/api/nodes'), {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({ nodeId, ...meta }),
      });
      if (!res.ok) throw new Error(`heartbeat failed: HTTP ${res.status}`);
    },
  };
}

/**
 * Adapter for Vercel Queues Poll Mode (cross-platform consumption).
 *
 * The SDK client is injected rather than imported: Queues is beta, and this
 * node should keep working if the SDK surface moves. Pass a PollingQueueClient
 * compatible object:
 *
 *   const transport = makeVercelQueueTransport({ client, consumerGroup: 'worker-a' });
 *
 * NOTE: exact method names on the beta client could not be verified from the
 * docs fetch; the shim below resolves the first matching name it finds and
 * throws a clear error if none exist, rather than silently doing nothing.
 */
export function makeVercelQueueTransport({ client, consumerGroup = 'swarm-workers' }) {
  const pick = (obj, names) => {
    for (const n of names) if (typeof obj?.[n] === 'function') return obj[n].bind(obj);
    return null;
  };

  const receiveFn = pick(client, ['receive', 'poll', 'receiveMessages', 'getMessages']);
  const ackFn = pick(client, ['ack', 'acknowledge', 'ackMessage']);
  const failFn = pick(client, ['fail', 'nack', 'failMessage']);

  return {
    kind: 'vercel-queue',

    async receive({ limit = 5, visibilityMs = 60_000 } = {}) {
      if (!receiveFn) throw new Error('vercel-queue transport: client has no receive() method');
      const out = await receiveFn({ limit, visibilityMs, consumerGroup });
      const arr = Array.isArray(out) ? out : (out?.messages ?? []);
      return arr.map((m) => ({
        messageId: m.messageId ?? m.id,
        taskId: m.taskId ?? m.id,
        title: m.title ?? m.name ?? '(untitled)',
        kind: m.kind,
        payload: m.payload ?? m.body ?? null,
        attempts: m.attempts ?? 1,
      }));
    },

    async ack(messageId, result) {
      if (!ackFn) throw new Error('vercel-queue transport: client has no ack() method');
      await ackFn(messageId, result);
    },

    async fail(messageId, error) {
      if (!failFn) throw new Error('vercel-queue transport: client has no fail() method');
      await failFn(messageId, String(error?.message ?? error));
    },
  };
}

/**
 * In-memory transport for tests and local dry runs. Records every ack/fail so
 * the daemon protocol can be asserted without a network or a broker.
 */
export function makeMemoryTransport({ messages = [], failReceive = false } = {}) {
  const script = [...messages];
  const calls = { acks: [], fails: [], heartbeats: [], receives: 0 };
  return {
    kind: 'memory',
    calls,
    async receive(opts = {}) {
      calls.receives += 1;
      if (failReceive) throw new Error('receive exploded');
      calls.lastReceiveOpts = opts;
      return script.splice(0, opts.limit ?? script.length);
    },
    async ack(id, result) { calls.acks.push({ id, result }); },
    async fail(id, error) { calls.fails.push({ id, error: String(error?.message ?? error) }); },
    async heartbeat(nodeId, meta) { calls.heartbeats.push({ nodeId, meta }); },
  };
}
