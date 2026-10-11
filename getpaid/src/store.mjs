/**
 * File-backed store: the whole dataset is one JSON document, written
 * atomically (tmp file + rename) so a crash mid-write cannot leave a
 * half-written ledger behind.
 *
 * Deliberately not a database. The point of this app is to move money for a
 * business with tens-to-thousands of invoices, and one JSON file handles that
 * with zero operational surface. See README "When to graduate to Postgres".
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const EMPTY = () => ({
  version: 1,
  invoices: [],
  payments: [],
  events: [],
  subscriptions: [],
  meta: { createdAt: new Date().toISOString() },
});

export const newId = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;

export class Store {
  /** @param {string} file absolute path to the JSON document */
  constructor(file) {
    this.file = file;
    this.tmp = join(dirname(file), `.${file.split('/').pop()}.tmp`);
    mkdirSync(dirname(file), { recursive: true });
    this.data = this.#read();
  }

  #read() {
    if (!existsSync(this.file)) return EMPTY();
    const raw = readFileSync(this.file, 'utf8');
    if (raw.trim() === '') return EMPTY();
    const parsed = JSON.parse(raw); // a corrupt ledger must fail loudly, not silently reset
    return { ...EMPTY(), ...parsed };
  }

  /** Atomic write: rename-atomic, which is what matters here. */
  save() {
    writeFileSync(this.tmp, JSON.stringify(this.data, null, 2));
    renameSync(this.tmp, this.file);
    return this;
  }

  /** Re-read from disk (used by tests + the CLI's long-running server). */
  reload() {
    this.data = this.#read();
    return this;
  }

  // ---- invoices -----------------------------------------------------------

  /**
   * @param {{number?:string, customer:{name?:string, email:string}, amountCents:number,
   *          currency?:string, issuedAt?:string, dueAt:string, notes?:string, id?:string}} input
   */
  addInvoice(input) {
    if (!input || typeof input !== 'object') throw new TypeError('invoice required');
    if (!input.customer?.email) throw new TypeError('invoice.customer.email is required');
    if (!input.dueAt) throw new TypeError('invoice.dueAt is required');
    const invoice = {
      id: input.id ?? newId('inv'),
      number: input.number ?? `INV-${this.data.invoices.length + 1001}`,
      customer: { name: input.customer.name ?? '', email: input.customer.email },
      currency: input.currency ?? 'USD',
      amountCents: input.amountCents,
      lateFeeCents: 0,
      paidCents: 0,
      issuedAt: input.issuedAt ?? new Date().toISOString(),
      dueAt: input.dueAt,
      status: 'open',
      dunning: {},
      notes: input.notes ?? '',
      createdAt: new Date().toISOString(),
    };
    this.data.invoices.push(invoice);
    this.#event('invoice.created', { invoiceId: invoice.id, amountCents: invoice.amountCents });
    return invoice;
  }

  getInvoice(id) {
    return this.data.invoices.find((i) => i.id === id || i.number === id) ?? null;
  }

  listInvoices({ status } = {}) {
    const all = [...this.data.invoices].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return status ? all.filter((i) => i.status === status) : all;
  }

  /** Amount still owed: principal + late fee - anything already received. */
  amountDueCents(invoice) {
    return Math.max(0, invoice.amountCents + invoice.lateFeeCents - invoice.paidCents);
  }

  daysOverdue(invoice, now = new Date()) {
    const ms = now.getTime() - new Date(invoice.dueAt).getTime();
    return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
  }

  /** @returns {boolean} true if this payment settled the invoice in full */
  recordPayment(invoiceId, cents, { at = new Date().toISOString(), method = 'stripe', reference = '' } = {}) {
    const invoice = this.getInvoice(invoiceId);
    if (!invoice) throw new Error(`no such invoice: ${invoiceId}`);
    if (!Number.isInteger(cents) || cents <= 0) throw new TypeError('payment must be a positive integer of cents');
    this.data.payments.push({ id: newId('pay'), invoiceId: invoice.id, cents, at, method, reference });
    invoice.paidCents += cents;
    const settled = this.amountDueCents(invoice) === 0;
    if (settled) {
      invoice.status = 'paid';
      invoice.paidAt = at;
    }
    this.#event(settled ? 'invoice.paid' : 'invoice.partial_payment', { invoiceId: invoice.id, cents, method });
    return settled;
  }

  markPaid(invoiceId, opts) {
    const invoice = this.getInvoice(invoiceId);
    if (!invoice) throw new Error(`no such invoice: ${invoiceId}`);
    return this.recordPayment(invoiceId, this.amountDueCents(invoice), opts);
  }

  voidInvoice(invoiceId) {
    const invoice = this.getInvoice(invoiceId);
    if (!invoice) throw new Error(`no such invoice: ${invoiceId}`);
    invoice.status = 'void';
    this.#event('invoice.void', { invoiceId: invoice.id });
    return invoice;
  }

  /** Record that a dunning stage went out (or was deliberately skipped). */
  markDunning(invoiceId, stage, { at = new Date().toISOString(), disposition = 'sent' } = {}) {
    const invoice = this.getInvoice(invoiceId);
    if (!invoice) throw new Error(`no such invoice: ${invoiceId}`);
    invoice.dunning[stage] = { at, disposition };
    return invoice;
  }

  // ---- subscriptions (the app's own revenue) ------------------------------

  addSubscription(input) {
    const sub = {
      id: input.id ?? newId('sub'),
      customerEmail: input.customerEmail,
      planId: input.planId,
      interval: input.interval ?? 'month',
      status: input.status ?? 'active',
      startedAt: input.startedAt ?? new Date().toISOString(),
      canceledAt: input.canceledAt ?? null,
      externalId: input.externalId ?? '',
    };
    this.data.subscriptions.push(sub);
    this.#event('subscription.created', { subscriptionId: sub.id, planId: sub.planId });
    return sub;
  }

  listSubscriptions() {
    return [...this.data.subscriptions];
  }

  // ---- events (append-only audit trail) -----------------------------------

  #event(type, payload) {
    this.data.events.push({ id: newId('evt'), type, at: new Date().toISOString(), ...payload });
  }

  addEvent(type, payload) {
    this.#event(type, payload);
    return this;
  }

  listEvents({ since } = {}) {
    const all = [...this.data.events];
    return since ? all.filter((e) => e.at >= since) : all;
  }

  /** Remove the tmp file, if a crash left one. Returns true if it removed something. */
  cleanTmp() {
    if (!existsSync(this.tmp)) return false;
    unlinkSync(this.tmp);
    return true;
  }
}

/** Convenience: open a store at the conventional data path. */
export function openStore(file) {
  return new Store(file);
}
