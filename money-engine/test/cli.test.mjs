import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../cli.mjs';
import { InputError } from '../src/engine.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));

const cli = (args) => run('node', [CLI, ...args]).then((r) => r.stdout, (e) => e);

test('parseArgs maps short flags onto engine fields', () => {
  const args = parseArgs(['--price', '150', '--var', '30', '--fixed=900', '--hours', '25', '--mode', 'flow']);
  assert.deepEqual(args, {
    price: 150,
    variableCostPct: 30,
    fixedCostMonthly: 900,
    hoursPerWeek: 25,
    mode: 'flow',
  });
});

test('parseArgs keeps playbook ids as strings and numbers as numbers', () => {
  const args = parseArgs(['--playbook', 'micro-saas', '--units', '40']);
  assert.equal(args.playbook, 'micro-saas');
  assert.equal(args.units, 40);
});

test('parseArgs rejects unknown flags and missing values', () => {
  assert.throws(() => parseArgs(['--nope', '1']), InputError);
  assert.throws(() => parseArgs(['--price']), InputError);
});

test('parseArgs handles --json and --help without consuming a value', () => {
  assert.equal(parseArgs(['--json', '--price', '5']).json, true);
  assert.equal(parseArgs(['--help']).help, true);
});

test('the report prints every section for a playbook run', async () => {
  const out = await cli(['--playbook', 'micro-saas', '--target', '3000']);
  assert.match(out, /MONEY ENGINE/);
  assert.match(out, /WHERE IT LANDS/);
  assert.match(out, /WHAT IT TAKES/);
  assert.match(out, /LEVERS, RANKED BY ANNUAL IMPACT/);
  assert.match(out, /TO CLEAR \$3,000\/MONTH, NET/);
  assert.match(out, /Units to break even/);
});

test('--json emits a machine-readable projection', async () => {
  const out = await cli(['--playbook', 'freelance', '--months', '6', '--json']);
  const parsed = JSON.parse(out);
  assert.equal(parsed.series.length, 6);
  assert.equal(parsed.config.mode, 'flow');
  assert.ok(Array.isArray(parsed.sensitivities));
});

test('explicit flags override a playbook preset', async () => {
  const out = await cli(['--playbook', 'micro-saas', '--price', '99', '--json']);
  assert.equal(JSON.parse(out).config.price, 99);
});

test('an unknown playbook exits 2 with the available list', async () => {
  const err = await cli(['--playbook', 'unicorns']);
  assert.equal(err.code, 2);
  assert.match(err.stderr, /Unknown playbook "unicorns"/);
  assert.match(err.stderr, /micro-saas/);
});

test('bad input exits 2 rather than crashing', async () => {
  const err = await cli(['--price', 'free']);
  assert.equal(err.code, 2);
  assert.match(err.stderr, /Input error/);
});

test('--help prints usage and exits 0', async () => {
  const out = await cli(['--help']);
  assert.match(out, /node cli\.mjs \[flags\]/);
  assert.match(out, /Playbooks:/);
});

test('the default run needs no arguments at all', async () => {
  const out = await cli([]);
  assert.match(out, /MONEY ENGINE/);
  assert.match(out, /Scenario/);
});

test('a scenario that loses money says so instead of hiding it', async () => {
  const out = await cli(['--mode', 'flow', '--price', '10', '--units', '2', '--fixed', '5000', '--months', '6']);
  assert.match(out, /WATCH OUT/);
  assert.match(out, /never reaches monthly profitability/);
});
