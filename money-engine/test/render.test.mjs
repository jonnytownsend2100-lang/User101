/**
 * Render smoke test.
 *
 * public/app.js is a browser module. Rather than trusting that it works, this
 * builds a minimal DOM stub, feeds the real engine's output through the real
 * render functions, and asserts that markup actually comes out. It catches the
 * whole class of "typo breaks the dashboard" bugs that unit tests miss.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { simulate, goalSeek } from '../src/engine.mjs';
import { PLAYBOOKS } from '../src/playbooks.mjs';

const html = await readFile(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

function makeStubElement(id) {
  return {
    id,
    value: '',
    innerHTML: '',
    textContent: '',
    hidden: false,
    style: {},
    dataset: {},
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    scrollIntoView() {},
    click() {},
    fire(type, event = {}) {
      for (const fn of this.listeners[type] ?? []) fn({ target: this, ...event });
    },
  };
}

const elements = new Map();
function el(id) {
  if (!elements.has(id)) elements.set(id, makeStubElement(id));
  return elements.get(id);
}

// Seed input values from the markup so the test exercises the shipped defaults.
function seedFromHtml() {
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    const id = tag.match(/id="([^"]+)"/)?.[1];
    if (!id) continue;
    const value = tag.match(/value="([^"]*)"/)?.[1] ?? '';
    el(id).value = value;
  }
  for (const m of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const [, id, inner] = m;
    const first = inner.match(/<option value="([^"]*)"/);
    const selected = inner.match(/<option value="([^"]*)"\s+selected/);
    el(id).value = selected?.[1] ?? first?.[1] ?? '';
  }
}

const fetchCalls = [];

function stubFetch(url, options = {}) {
  fetchCalls.push({ url, options });
  const body = options.body ? JSON.parse(options.body) : {};
  if (url === '/api/playbooks') {
    return Promise.resolve({ ok: true, json: async () => ({ playbooks: PLAYBOOKS }) });
  }
  if (url === '/api/simulate') {
    const result = simulate(body);
    if (body.targetMonthlyNet !== undefined) result.goal = goalSeek(result.config, body.targetMonthlyNet);
    return Promise.resolve({ ok: true, status: 200, json: async () => result });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'not found' }) });
}

before(async () => {
  seedFromHtml();
  globalThis.document = {
    getElementById: (id) => el(id),
    createElement: () => makeStubElement('created'),
  };
  globalThis.fetch = stubFetch;
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
  await import('../public/app.js');
  // Let boot()'s promise chain settle.
  await new Promise((r) => setTimeout(r, 400));
});

test('the script loaded and asked the server for a projection', () => {
  assert.ok(fetchCalls.some((c) => c.url === '/api/playbooks'), 'playbooks were never fetched');
  assert.ok(fetchCalls.some((c) => c.url === '/api/simulate'), 'no simulation was requested');
});

test('headline cards rendered with real numbers', () => {
  const out = el('headline').innerHTML;
  assert.match(out, /class="card"/);
  assert.match(out, /\$/, 'expected at least one money value');
  assert.match(out, /Break-even volume/);
  assert.match(out, /Effective hourly rate/);
});

test('the chart rendered as inline svg with a cumulative line', () => {
  const out = el('chart').innerHTML;
  assert.match(out, /^<svg/);
  assert.match(out, /<path d="M/);
  assert.match(out, /paid back|setup cost|bars = monthly net/);
});

test('the ledger table rendered a row per month', () => {
  const out = el('table-wrap').innerHTML;
  assert.match(out, /<table><thead>/);
  const rows = (out.match(/<tr>/g) ?? []).length;
  assert.ok(rows >= 25, `expected a header plus ~24 months, saw ${rows}`);
});

test('the lever list rendered ranked bars', () => {
  const out = el('sensitivity').innerHTML;
  assert.match(out, /class="lever"/);
  assert.match(out, /Raise price 10%/);
  assert.match(out, /lever-fill/);
});

test('the goal panel rendered the target answer', () => {
  const out = el('goal-body').innerHTML;
  assert.match(out, /Customers needed/);
  assert.match(out, /\$3,000\/mo/);
});

test('the playbook grid rendered a loadable card per playbook', () => {
  const out = el('playbook-grid').innerHTML;
  assert.equal((out.match(/<article class="pb">/g) ?? []).length, PLAYBOOKS.length);
  assert.match(out, /data-load="micro-saas"/);
  assert.match(out, /Why most fail/);
});

test('the playbook selector was populated', () => {
  const out = el('playbook').innerHTML;
  assert.match(out, /Blank scenario/);
  assert.match(out, /value="local-service"/);
});

test('clicking a playbook card loads its preset and re-runs', () => {
  const before = fetchCalls.length;
  el('playbook-grid').fire('click', { target: { dataset: { load: 'micro-saas' } } });
  assert.equal(el('label').value, 'Micro-SaaS');
  assert.equal(el('mode').value, 'recurring');
  assert.equal(el('price').value, 29);
  return new Promise((resolve) =>
    setTimeout(() => {
      assert.ok(fetchCalls.length > before, 'no re-simulation after loading a playbook');
      assert.equal(JSON.parse(fetchCalls.at(-1).options.body).price, 29);
      resolve();
    }, 300)
  );
});

test('a failed request surfaces a readable status instead of throwing', () => {
  globalThis.fetch = () => Promise.reject(new Error('network down'));
  el('price').fire('input');
  return new Promise((resolve) =>
    setTimeout(() => {
      assert.match(el('status').textContent, /Could not model that: network down/);
      globalThis.fetch = stubFetch;
      resolve();
    }, 300)
  );
});
