import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { buildReport, ageingBuckets, formatReport } from '../src/report.mjs';
import { mrrCents, arrCents, monthlyEquivalentCents, priceCents, getPlan, PLANS } from '../src/billing.mjs';

const NOW = new Date('2026-01-15T12:00:00.000Z');
const DAY = 86_400_000;
const at = (days) => new Date(NOW.getTime() + days * DAY).toISOString();

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'getpaid-report-'));
  return { store: new Store(join(dir, 'ledger.json')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const add = (store, amountCents, daysOverdue) =>
  store.addInvoice({ customer: { email: 'x@example.com' }, amountCents, dueAt: at(-daysOverdue) });

test('ageing buckets classify every open invoice exactly once', () => {
  const { store, cleanup } = harness();
  add(store, 100, -5); // not due yet
  add(store, 200, 3);
  add(store, 400, 10);
  add(store, 800, 20);
  add(store, 1600, 60);

  const buckets = Object.fromEntries(ageingBuckets(store, { now: NOW }).map((b) => [b.key, b]));
  assert.equal(buckets.current.cents, 100);
  assert.equal(buckets['1-7'].cents, 200);
  assert.equal(buckets['8-14'].cents, 400);
  assert.equal(buckets['15-30'].cents, 800);
  assert.equal(buckets['31+'].cents, 1600);
  assert.equal(Object.values(buckets).reduce((n, b) => n + b.count, 0), 5);
  cleanup();
});

test('the report separates outstanding from overdue and counts only real money', () => {
  const { store, cleanup } = harness();
  add(store, 1000, 10);
  add(store, 500, -3); // not due
  const paid = add(store, 2000, 40);
  store.recordPayment(paid.id, 2000, { at: at(-1) });

  const report = buildReport(store, { now: NOW });
  assert.equal(report.outstandingCents, 1500);
  assert.equal(report.overdueCents, 1000, 'the not-yet-due invoice is not overdue');
  assert.equal(report.recoveredCents, 2000);
  assert.equal(report.billedCents, 3500);
  assert.equal(report.recoveryRateBps, 5714);
  assert.equal(report.counts.paid, 1);
  assert.equal(report.counts.open, 2);
  cleanup();
});

test('the window only counts payments inside it', () => {
  const { store, cleanup } = harness();
  const old = add(store, 1000, 90);
  const recent = add(store, 2000, 90);
  store.recordPayment(old.id, 1000, { at: at(-45) });
  store.recordPayment(recent.id, 2000, { at: at(-2) });

  const report = buildReport(store, { now: NOW, windowDays: 30 });
  assert.equal(report.recoveredCents, 3000, 'all-time total is unaffected');
  assert.equal(report.recoveredInWindowCents, 2000);
  assert.equal(report.recoveredInWindowCount, 1);
  cleanup();
});

test('average days late is computed from the due date, and is null when nothing settled', () => {
  const { store, cleanup } = harness();
  const empty = buildReport(store, { now: NOW });
  assert.equal(empty.avgDaysLateDays, null);
  assert.equal(empty.recoveryRateBps, 0, 'no divide-by-zero in an empty book');

  const a = add(store, 100, 30);
  const b = add(store, 100, 30);
  store.recordPayment(a.id, 100, { at: at(-20) }); // 10 days late
  store.recordPayment(b.id, 100, { at: at(-10) }); // 20 days late
  const report = buildReport(store, { now: NOW });
  assert.equal(report.avgDaysLateDays, 15);
  cleanup();
});

test('void invoices never inflate the recovery-rate denominator', () => {
  const { store, cleanup } = harness();
  const inv = add(store, 5000, 20);
  store.voidInvoice(inv.id);
  const report = buildReport(store, { now: NOW });
  assert.equal(report.billedCents, 0);
  assert.equal(report.outstandingCents, 0);
  cleanup();
});

test('MRR counts active subscriptions only, and normalises annual to monthly', () => {
  const { store, cleanup } = harness();
  store.addSubscription({ customerEmail: 'a@example.com', planId: 'starter', interval: 'month' });
  store.addSubscription({ customerEmail: 'b@example.com', planId: 'growth', interval: 'year' });
  store.addSubscription({ customerEmail: 'c@example.com', planId: 'scale', interval: 'month', status: 'canceled' });

  // 2900 + round(99000/12 = 8250) + (canceled excluded)
  assert.equal(mrrCents(store), 2900 + 8250);
  assert.equal(arrCents(store), (2900 + 8250) * 12);
  assert.equal(monthlyEquivalentCents({ planId: 'unknown', interval: 'month' }), 0);
  cleanup();
});

test('plan prices are integer cents and unknown plans are refused', () => {
  assert.equal(priceCents('starter', 'month'), 2900);
  assert.equal(priceCents('growth', 'year'), 99000);
  assert.equal(getPlan('scale').name, 'Scale');
  assert.throws(() => getPlan('free'), /unknown plan/);
  assert.throws(() => priceCents('starter', 'week'), /unknown interval/);
  for (const plan of PLANS) {
    assert.ok(Number.isInteger(plan.monthlyCents) && plan.monthlyCents > 0, `${plan.id} price must be integer cents`);
    assert.ok(plan.annualCents < plan.monthlyCents * 12, `${plan.id} annual must be a discount`);
  }
});

test('formatReport is readable and mentions the headline number', () => {
  const { store, cleanup } = harness();
  const inv = add(store, 123456, 12);
  store.recordPayment(inv.id, 123456, { at: at(-1) });
  const text = formatReport(buildReport(store, { now: NOW }));
  assert.match(text, /Recovered \(all time\): \$1234\.56/);
  assert.match(text, /Recovery rate: 100\.0%/);
  assert.match(text, /App MRR: \$0\.00/);
  cleanup();
});
