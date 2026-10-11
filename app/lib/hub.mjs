/**
 * Tiny Server-Sent-Events hub + bounded event log.
 *
 * Two channels go to the browser:
 *   event: state  - the full current snapshot (tasks/nodes/stats), pushed only
 *                   when it actually changes;
 *   event: log    - append-only activity records, pushed as they happen.
 *
 * Keeping them separate means a busy worker pool does not re-send the whole
 * board on every tick, and the log can be rendered as a live feed.
 */
export function createHub({ maxEvents = 300 } = {}) {
  const clients = new Set();
  const events = [];
  let seq = 0;

  function write(res, name, data) {
    try {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  return {
    get clientCount() {
      return clients.size;
    },

    events() {
      return [...events];
    },

    addClient(res) {
      clients.add(res);
      return () => clients.delete(res);
    },

    /** Record an activity event and stream it to every connected client. */
    log(event) {
      const record = { id: ++seq, at: new Date().toISOString(), ...event };
      events.push(record);
      if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
      for (const res of clients) write(res, 'log', record);
      return record;
    },

    broadcastState(state) {
      for (const res of clients) write(res, 'state', state);
    },
  };
}
