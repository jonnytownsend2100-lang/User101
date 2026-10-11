/**
 * Money Engine server — node stdlib only, no dependencies, no build step.
 *
 *   GET  /                  the app
 *   GET  /api/playbooks     the playbook library
 *   GET  /api/health        liveness
 *   POST /api/simulate      { ...inputs } -> full projection + levers
 *   POST /api/goal-seek     { ...inputs, targetMonthlyNet } -> what it takes
 *   POST /api/export.csv    { ...inputs } -> the monthly ledger as CSV
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as pathNormalize, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate, goalSeek, InputError } from './src/engine.mjs';
import { PLAYBOOKS } from './src/playbooks.mjs';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_BODY = 64 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new InputError('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InputError('Body must be a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err instanceof InputError) throw err;
    throw new InputError('Body must be valid JSON');
  }
}

/**
 * Resolve a URL path to a file inside public/, or null if it escapes.
 * Containment is checked with path.relative rather than string prefixes, so
 * trailing separators and encoded traversal cannot slip past it.
 */
function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  const full = pathNormalize(join(ROOT, decoded.replace(/^\/+/, '')));
  const relToRoot = relative(ROOT, full);
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot) || relToRoot.includes('\0')) return null;
  return full;
}

export function toCsv(result) {
  const cols = ['month', 'units', 'revenue', 'variableCost', 'grossProfit', 'newUnits', 'acquisitionCost', 'opex', 'operatingProfit', 'tax', 'netProfit', 'cumulativeNet'];
  const fmt = (v) => (v === null || v === undefined || Number.isNaN(v) ? '' : Math.round(v * 100) / 100);
  const last = result.series[result.series.length - 1];
  const lines = [cols.join(',')];
  for (const row of result.series) lines.push(cols.map((c) => fmt(row[c])).join(','));
  // Totals row: money columns sum, units show the final month, cumulative is already a running total.
  lines.push(
    cols
      .map((c) => {
        if (c === 'month') return 'TOTAL';
        if (c === 'units') return fmt(last?.units);
        if (c === 'cumulativeNet') return fmt(last?.cumulativeNet);
        return fmt(result.series.reduce((a, r) => a + (Number(r[c]) || 0), 0));
      })
      .join(',')
  );
  return lines.join('\n') + '\n';
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname;

    try {
      if (req.method === 'GET' && route === '/api/health') {
        return json(res, 200, { ok: true, service: 'money-engine' });
      }
      if (req.method === 'GET' && route === '/api/playbooks') {
        return json(res, 200, { playbooks: PLAYBOOKS });
      }
      if (req.method === 'POST' && route === '/api/simulate') {
        const body = await readJsonBody(req);
        const result = simulate(body);
        if (body.targetMonthlyNet !== undefined) {
          result.goal = goalSeek(result.config, body.targetMonthlyNet);
        }
        return json(res, 200, result);
      }
      if (req.method === 'POST' && route === '/api/goal-seek') {
        const body = await readJsonBody(req);
        const base = simulate(body);
        return json(res, 200, goalSeek(base.config, body.targetMonthlyNet));
      }
      if (req.method === 'POST' && route === '/api/export.csv') {
        const body = await readJsonBody(req);
        const result = simulate(body);
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="money-engine-projection.csv"',
        });
        return res.end(toCsv(result));
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'Method not allowed' });
      }

      const file = resolveStatic(route === '/' ? '/index.html' : route);
      if (!file) return json(res, 400, { error: 'Bad path' });
      try {
        const data = await readFile(file);
        return send(res, 200, data, TYPES[extname(file)] ?? 'application/octet-stream');
      } catch {
        return json(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      if (err instanceof InputError) return json(res, 400, { error: err.message });
      return json(res, 500, { error: 'Internal error' });
    }
  });
}
export { resolveStatic };




const isMain = process.argv[1] && pathNormalize(process.argv[1]) === pathNormalize(fileURLToPath(import.meta.url));
if (isMain) {
  createApp().listen(PORT, HOST, () => {
    console.log(`Money Engine running at http://${HOST}:${PORT}`);
  });
}
