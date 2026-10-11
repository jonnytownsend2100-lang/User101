import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { runDunning, dueStages, pick, render, DEFAULT_POLICY } from '../src/dunning.mjs';

const NOW = new Date('2026-01-15T12:00:00.000Z');
const DAY = 86_400_000;
const at = (days) => new Date(NOW.getTime() + days * DAY).toISOString();

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'getpaid-dunning-'));
  const store = new Store(join(dir, 'ledger.json'));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const add = (store, over = {}) =>
  store.addInvoice({ customer: { name: 'Dana', email: 'dana@example.com' }, amountCents: 100000, dueAt: at(-1), ...over });

test('render substitutes known variables and leaves unknown ones alone', () => {
  assert.equal(render('Hi {name}, {missing}', { name: 'Dana' }), 'Hi Dana, {missing}');
});

test('an invoice that is not yet due is never chased', async () => {
  const { store, cleanup } = harness();
  add(store, { dueAt: at(5) });
  const summary = await runDunning(store, { now: NOW, send: async () => {} });
  assert.deepEqual(summary.sent, []);
  assert.equal(summary.considered, 1);
  cleanup();
});

test('day 1 sends the nudge and nothing else', async () => {
  const { store, cleanup } = harness();
  const inv = add(store, { dueAt: at(-1) });
  const sent = [];
  const summary = await runDunning(store, { now: NOW, send: async (m) => sent.push(m) });

  assert.equal(summary.sent.length, 1);
  assert.equal(summary.sent[0].stage, 'nudge');
  assert.equal(sent[0].to, 'dana@example.com');
  assert.match(sent[0].subject, new RegExp(inv.number));
  assert.match(sent[0].text, /\$1,000\.00/);
  assert.equal(store.getInvoice(inv.id).dunning.nudge.disposition, 'sent');
  cleanup();
});

test('running twice in a row sends exactly one email', async () => {
  const { store, cleanup } = harness();
  add(store, { dueAt: at(-3) });
  const sent = [];
  await runDunning(store, { now: NOW, send: async (m) => sent.push(m) });
  const second = await runDunning(store, { now: NOW, send: async (m) => sent.push(m) });
  assert.equal(sent.length, 1);
  assert.deepEqual(second.sent, [], 'the ladder must be idempotent');
  cleanup();
});

test('a long outage does not produce catch-up spam: only the furthest stage goes out', async () => {
  const { store, cleanup } = harness();
  const inv = add(store, { dueAt: at(-30) });
  const sent = [];
  const summary = await runDunning(store, { now: NOW, send: async (m) => sent.push(m) });

  assert.equal(sent.length, 1, 'one email, not four');
  assert.equal(sent[0].stage, 'final');
  assert.deepEqual(summary.skipped.map((s) => s.stage), ['nudge', 'reminder', 'firm']);
  const marks = store.getInvoice(inv.id).dunning;
  assert.equal(marks.nudge.disposition, 'skipped');
  assert.equal(marks.firm.disposition, 'skipped');
  assert.equal(marks.final.disposition, 'sent');

  assert.equal(store.getInvoice(inv.id).lateFeeCents, 1500, 'the fee is due even though the firm email was superseded');

  const again = await runDunning(store, { now: NOW, send: async (m) => sent.push(m) });
  assert.deepEqual(again.sent, [], 'skipped stages must never fire later');
  cleanup();
});

test('the ladder escalates over time, one rung at a time', async () => {
  const { store, cleanup } = harness();
  const inv = add(store, { dueAt: at(-1) });
  const stages = [];
  for (const day of [0, 7, 14, 21, 40]) {
    await runDunning(store, {
      now: new Date(NOW.getTime() + day * DAY),
      send: async (m) => stages.push(m.stage),
    });
  }
  assert.deepEqual(stages, ['nudge', 'reminder', 'firm', 'final']);
  assert.equal(store.getInvoice(inv.id).lateFeeCents, 1500, '1.5% late fee applied on the firm stage');
  cleanup();
});

test('the late fee is applied exactly once', async () => {
  const { store, cleanup } = harness();
  const inv = add(store, { dueAt: at(-14), amountCents: 100000 });
  await runDunning(store, { now: NOW, send: async () => {} });
  assert.equal(store.getInvoice(inv.id).lateFeeCents, 1500);

  const later = new Date(NOW.getTime() + 20 * DAY);
  await runDunning(store, { now: later, send: async () => {} });
  assert.equal(store.getInvoice(inv.id).lateFeeCents, 1500, 'no compounding fee');
  cleanup();
});

test('paid and void invoices are never chased', async () => {
  const { store, cleanup } = harness();
  const paid = add(store, { dueAt: at(-30) });
  const voided = add(store, { dueAt: at(-30) });
  store.markPaid(paid.id);
  store.voidInvoice(voided.id);

  const sent = [];
  const summary = await runDunning(store, { now: NOW, send: async (m) => sent.push(m) });
  assert.equal(sent.length, 0);
  assert.equal(summary.considered, 0, 'only open invoices are considered');
  cleanup();
});

test('a failed send is not recorded as sent, so the next run retries it', async () => {
  const { store, cleanup } = harness();
  const inv = add(store, { dueAt: at(-2) });
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('smtp 421 try later');
  };

  const first = await runDunning(store, { now: NOW, send: flaky });
  assert.equal(first.failed.length, 1);
  assert.match(first.failed[0].error, /smtp 421/);
  assert.deepEqual(store.getInvoice(inv.id).dunning, {}, 'nothing was marked');

  const second = await runDunning(store, { now: NOW, send: flaky });
  assert.equal(second.sent.length, 1, 'the retry actually sends');
  cleanup();
});

test('dry run reports what it would do without touching the ledger', async () => {
  const { store, cleanup } = harness();
  const inv = add(store, { dueAt: at(-25) });
  const summary = await runDunning(store, { now: NOW, dryRun: true, send: async () => {} });
  assert.equal(summary.wouldSend.length, 1);
  assert.equal(summary.wouldSend[0].stage, 'final');
  assert.deepEqual(store.getInvoice(inv.id).dunning, {});
  assert.equal(store.getInvoice(inv.id).lateFeeCents, 0);
  cleanup();
});

test('the payment link reaches the email body', async () => {
  const { store, cleanup } = harness();
  add(store, { dueAt: at(-8) });
  const sent = [];
  await runDunning(store, {
    now: NOW,
    send: async (m) => sent.push(m),
    linkFactory: (invoice) => `https://pay.test/${invoice.id}`,
  });
  assert.match(sent[0].text, /https:\/\/pay\.test\/inv_/);
  cleanup();
});

test('dueStages and pick are pure planning helpers', () => {
  const { store, cleanup } = harness();
  const inv = add(store, { dueAt: at(-8) });
  const plan = dueStages(inv, store, { now: NOW });
  assert.deepEqual(plan.due.map((s) => s.stage), ['nudge', 'reminder']);
  assert.equal(pick(plan).send.stage, 'reminder');
  assert.deepEqual(pick(plan).skip.map((s) => s.stage), ['nudge']);
  assert.equal(pick({ due: [] }).send, null);
  assert.equal(DEFAULT_POLICY.length, 4);
  cleanup();
});
