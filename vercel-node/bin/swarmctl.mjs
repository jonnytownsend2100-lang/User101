#!/usr/bin/env node
/**
 * swarmctl - controller CLI for the Vercel swarm node.
 *
 *   swarmctl submit "fix the bug" --kind add --payload '{"a":1,"b":2}'
 *   swarmctl nodes
 *   swarmctl drain            # run one poll cycle locally, then exit
 *   swarmctl daemon           # run this machine as a compute node
 *
 * Env: SWARM_BASE_URL (required), SWARM_API_KEY (optional), SWARM_NODE_ID.
 */
import { makeHttpPollTransport } from '../lib/transport.js';
import { createDaemon, tick, NODE_ID } from '../daemon.mjs';
import { makeExecutor } from '../lib/worker.js';
import { handlers } from '../lib/handlers.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const positional = (from = 1) => argv.slice(from).filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') === false);

function base() {
  const url = process.env.SWARM_BASE_URL;
  if (!url) { console.error('SWARM_BASE_URL is required (e.g. https://my-swarm.vercel.app)'); process.exit(1); }
  return url.replace(/\/+$/, '');
}

const headers = () => {
  const h = { 'content-type': 'application/json' };
  if (process.env.SWARM_API_KEY) h['x-api-key'] = process.env.SWARM_API_KEY;
  return h;
};

async function main() {
  switch (cmd) {
    case 'submit': {
      const title = positional().join(' ');
      if (!title) { console.error('usage: swarmctl submit "title" [--kind k] [--payload json]'); process.exit(1); }
      const payloadRaw = flag('payload');
      const res = await fetch(`${base()}/api/enqueue`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          title,
          kind: flag('kind') ?? undefined,
          payload: payloadRaw ? JSON.parse(payloadRaw) : null,
        }),
      });
      const body = await res.json();
      console.log(res.ok ? `submitted ${body.taskId}` : `failed: ${JSON.stringify(body)}`);
      process.exit(res.ok ? 0 : 1);
    }

    case 'nodes': {
      const res = await fetch(`${base()}/api/nodes`, { headers: headers() });
      const { nodes = [], alive, total } = await res.json();
      console.log(`${alive}/${total} nodes alive`);
      for (const n of nodes) {
        console.log(`  ${n.alive ? '●' : '○'} ${n.nodeId}  ${n.region ?? '-'}  ${n.ageMs != null ? Math.round(n.ageMs / 1000) + 's ago' : n.lastSeen ?? ''}`);
      }
      break;
    }

    case 'drain': {
      const transport = makeHttpPollTransport({ baseUrl: base(), apiKey: process.env.SWARM_API_KEY ?? null });
      const out = await tick({ transport, execute: makeExecutor({ handlers }), nodeId: NODE_ID, limit: Number(flag('limit', 5)) });
      console.log(JSON.stringify(out, null, 2));
      break;
    }

    case 'daemon': {
      const transport = makeHttpPollTransport({ baseUrl: base(), apiKey: process.env.SWARM_API_KEY ?? null });
      const d = createDaemon({
        transport,
        limit: Number(flag('limit', 5)),
        concurrency: Number(flag('concurrency', 2)),
      });
      await d.loop();
      break;
    }

    default:
      console.log('usage: swarmctl <submit|nodes|drain|daemon> [args]');
      process.exit(1);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
