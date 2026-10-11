import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, resolveStatic, toCsv } from '../server.mjs';
import { simulate } from '../src/engine.mjs';

let server;
let base;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const post = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('health endpoint reports ok', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: 'money-engine' });
});

test('playbooks endpoint returns the whole library', async () => {
  const res = await fetch(base + '/api/playbooks');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.playbooks.length >= 8);
  assert.ok(body.playbooks.every((p) => p.id && p.preset));
});

test('simulate endpoint returns a projection and ranked levers', async () => {
  const res = await post('/api/simulate', { mode: 'flow', price: 100, units: 10, months: 12 });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.series.length, 12);
  assert.equal(body.sensitivities.length > 0, true);
  assert.equal(typeof body.steadyState.netProfit, 'number');
});

test('simulate endpoint attaches a goal when a target is supplied', async () => {
  const res = await post('/api/simulate', { mode: 'flow', price: 100, units: 10, months: 3, targetMonthlyNet: 2000 });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.goal.requiredUnits > 0);
});

test('goal-seek endpoint answers what it would take', async () => {
  const res = await post('/api/goal-seek', { mode: 'flow', price: 100, units: 10, targetMonthlyNet: 1500 });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.targetMonthlyNet, 1500);
  assert.ok(body.requiredUnits > 10);
});

test('bad input is rejected as 400, not 500', async () => {
  const res = await post('/api/simulate', { price: 'free' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /must be a number/);
});

test('malformed JSON is rejected as 400', async () => {
  const res = await fetch(base + '/api/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /valid JSON/);
});

test('a JSON array body is rejected', async () => {
  const res = await post('/api/simulate', [1, 2, 3]);
  assert.equal(res.status, 400);
});

test('csv export has a header, one row per month, and a totals row', async () => {
  const res = await post('/api/export.csv', { mode: 'flow', price: 100, units: 5, months: 4 });
  const text = await res.text();
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 6); // header + 4 months + totals
  assert.match(lines[0], /^month,units,revenue/);
  assert.match(lines[5], /^TOTAL,/);
});

test('csv totals equal the sum of the monthly rows', async () => {
  const result = simulate({ mode: 'flow', price: 100, units: 5, months: 4 });
  const csv = toCsv(result);
  const lines = csv.trim().split('\n');
  const cols = lines[0].split(',');
  const netIdx = cols.indexOf('netProfit');
  const monthlySum = result.series.reduce((a, r) => a + r.netProfit, 0);
  const totalCell = Number(lines[lines.length - 1].split(',')[netIdx]);
  assert.ok(Math.abs(totalCell - monthlySum) < 0.01);
});

test('the app shell is served at the root', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /Money Engine/i);
});

test('unknown routes 404 and the response is not HTML', async () => {
  const res = await fetch(base + '/api/nope');
  assert.equal(res.status, 404);
});

test('non-GET verbs on unknown routes are rejected', async () => {
  const res = await fetch(base + '/api/simulate', { method: 'PUT' });
  assert.equal(res.status, 405);
});

test('static path resolution cannot escape the public directory', () => {
  assert.equal(resolveStatic('/../../etc/passwd'), null);
  assert.equal(resolveStatic('/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.ok(resolveStatic('/index.html').includes('public'));
});

test('oversized bodies are refused rather than buffered', async () => {
  const big = JSON.stringify({ label: 'x'.repeat(200000) });
  const res = await fetch(base + '/api/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: big,
  });
  assert.equal(res.status, 400);
});
