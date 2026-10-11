import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, openStore } from '../src/store.mjs';

const NOW = new Date('2026-01-15T12:00:00.000Z');
const DAY = 86_400_000;
const at = (days) => new Date(NOW.getTime() + days * DAY).toISOString();

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'getpaid-store-'));
  return { dir, file: join(dir, 'ledger.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const invoice = (over = {}) => ({
  customer: { name: 'Dana', email: 'dana@example.com' },
  amountCents: 10000,
  dueAt: at(-10),
  ...over,
});

test('invoice requires an email and a due date', () => {
  const { file, cleanup } = fresh();
  const store = new Store(file);
  assert.throws(() => store.addInvoice({ amountCents: 1, dueAt: at(0) }), /customer.email/);
  assert.throws(() => store.addInvoice({ customer: { email: 'a@b.c' }, amountCents: 1 }), /dueAt/);
  assert.throws(() => store.addInvoice(null), TypeError);
  cleanup();
});

test('state survives a process restart (new Store over the same file)', () => {
  const { file, cleanup } = fresh();
  const first = new Store(file);
  const created = first.addInvoice(invoice());
  first.save();

  const second = openStore(file);
  assert.equal(second.listInvoices().length, 1);
  assert.equal(second.getInvoice(created.id).amountCents, 10000);
  assert.equal(second.getInvoice(created.number).id, created.id, 'lookup by number works');
  cleanup();
});

test('writes are atomic: the tmp file never survives a save', () => {
  const { file, cleanup } = fresh();
  const store = new Store(file);
  store.addInvoice(invoice());
  store.save();
  assert.equal(existsSync(store.tmp), false, 'tmp file must be renamed away');
  assert.equal(existsSync(file), true);
  cleanup();
});

test('a corrupt ledger throws instead of silently resetting to empty', () => {
  const { file, cleanup } = fresh();
  writeFileSync(file, '{ this is not json');
  assert.throws(() => new Store(file), SyntaxError);
  cleanup();
});

test('partial payments leave the invoice open; full settlement closes it', () => {
  const { file, cleanup } = fresh();
  const store = new Store(file);
  const inv = store.addInvoice(invoice({ amountCents: 10000 }));

  assert.equal(store.recordPayment(inv.id, 4000), false);
  assert.equal(store.getInvoice(inv.id).status, 'open');
  assert.equal(store.amountDueCents(store.getInvoice(inv.id)), 6000);

  assert.equal(store.recordPayment(inv.id, 6000), true);
  assert.equal(store.getInvoice(inv.id).status, 'paid');
  assert.equal(store.amountDueCents(store.getInvoice(inv.id)), 0);
  assert.equal(store.data.payments.length, 2);
  cleanup();
});

test('amount due floors at zero and never goes negative', () => {
  const { file, cleanup } = fresh();
  const store = new Store(file);
  const inv = store.addInvoice(invoice({ amountCents: 5000 }));
  store.recordPayment(inv.id, 5000);
  store.recordPayment(inv.id, 2500); // a duplicate/overpayment arrives
  assert.equal(store.amountDueCents(store.getInvoice(inv.id)), 0);
  assert.equal(store.getInvoice(inv.id).paidCents, 7500);
  cleanup();
});

test('payments must be positive integer cents', () => {
  const { file, cleanup } = fresh();
  const store = new Store(file);
  const inv = store.addInvoice(invoice());
  assert.throws(() => store.recordPayment(inv.id, 0), TypeError);
  assert.throws(() => store.recordPayment(inv.id, -100), TypeError);
  assert.throws(() => store.recordPayment(inv.id, 10.5), TypeError);
  assert.throws(() => store.recordPayment('nope', 100), /no such invoice/);
  cleanup();
});

test('late fees stack into the balance, and days overdue is whole days', () => {
  const { file, cleanup } = fresh();
  const store = new Store(file);
  const inv = store.addInvoice(invoice({ amountCents: 100000, dueAt: at(-14) }));
  inv.lateFeeCents = 1500;
  assert.equal(store.amountDueCents(inv), 101500);
  assert.equal(store.daysOverdue(inv, NOW), 14);
  assert.equal(store.daysOverdue(store.addInvoice(invoice({ dueAt: at(3) })), NOW), 0, 'future due date is not overdue');
  cleanup();
});

test('events are an append-only trail of what happened to the money', () => {
  const { file, cleanup } = fresh();
  const store = new Store(file);
  const inv = store.addInvoice(invoice());
  store.markPaid(inv.id);
  const types = store.listEvents().map((e) => e.type);
  assert.deepEqual(types, ['invoice.created', 'invoice.paid']);
  assert.equal(store.listEvents({ since: '2999-01-01T00:00:00.000Z' }).length, 0, 'since filters forward');
  cleanup();
});

test('dunning marks are stored per stage and are idempotent', () => {
  const { file, cleanup } = fresh();
  const store = new Store(file);
  const inv = store.addInvoice(invoice());
  store.markDunning(inv.id, 'nudge');
  store.markDunning(inv.id, 'nudge', { disposition: 'skipped' });
  assert.equal(store.getInvoice(inv.id).dunning.nudge.disposition, 'skipped');
  assert.deepEqual(Object.keys(store.getInvoice(inv.id).dunning), ['nudge']);
  cleanup();
});

test('void invoices drop out of the open book but stay in the ledger', () => {
  const { file, cleanup } = fresh();
  const store = new Store(file);
  const inv = store.addInvoice(invoice());
  store.voidInvoice(inv.id);
  assert.equal(store.listInvoices({ status: 'open' }).length, 0);
  assert.equal(store.listInvoices().length, 1);
  cleanup();
});
