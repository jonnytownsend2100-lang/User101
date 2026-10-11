import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MODE_FLOW, MODE_RECURRING } from '../src/engine.mjs';

const read = (p) => readFile(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const html = await read('../public/index.html');
const js = await read('../public/app.js');
const css = await read('../public/styles.css');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('every element id the script touches exists in the markup', () => {
  const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  // NUMERIC_IDS and SUFFIX keys are also looked up by id.
  const arrayBlock = js.match(/const NUMERIC_IDS = \[([\s\S]*?)\];/)[1];
  for (const m of arrayBlock.matchAll(/'([a-zA-Z]+)'/g)) used.add(m[1]);
  const suffixBlock = js.match(/const SUFFIX = \{([\s\S]*?)\};/)[1];
  for (const m of suffixBlock.matchAll(/([a-zA-Z]+):/g)) used.add(m[1]);

  const missing = [...used].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `script references ids missing from index.html: ${missing.join(', ')}`);
});

test('every slider readout element exists for each suffixed input', () => {
  const suffixBlock = js.match(/const SUFFIX = \{([\s\S]*?)\};/)[1];
  const keys = [...suffixBlock.matchAll(/([a-zA-Z]+):/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5);
  for (const key of keys) {
    assert.ok(htmlIds.has(`${key}-out`), `missing readout element ${key}-out`);
    assert.ok(html.includes(`id="${key}"`), `missing input ${key}`);
  }
});

test('the mode selector offers exactly the engine modes', () => {
  const values = [...html.matchAll(/<option value="(recurring|flow)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(values, [MODE_FLOW, MODE_RECURRING].sort());
});

test('the page loads its own stylesheet and script', () => {
  assert.match(html, /href="\/styles\.css"/);
  assert.match(html, /src="\/app\.js"/);
  assert.ok(css.includes('--accent'));
});

test('the page states plainly that it does not generate money', () => {
  assert.match(html, /does not generate money/i);
  assert.match(html, /Honest limits/i);
});

test('the script calls only endpoints the server implements', () => {
  const called = [...js.matchAll(/fetch\('(\/api\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(called.length >= 3);
  const allowed = new Set(['/api/simulate', '/api/playbooks', '/api/export.csv']);
  for (const c of called) assert.ok(allowed.has(c), `app.js calls unknown endpoint ${c}`);
});

test('the markup has no unclosed obvious tags in the form area', () => {
  const opens = (html.match(/<fieldset>/g) ?? []).length;
  const closes = (html.match(/<\/fieldset>/g) ?? []).length;
  assert.equal(opens, closes);
  assert.equal((html.match(/<div/g) ?? []).length, (html.match(/<\/div>/g) ?? []).length);
});
