/**
 * Dunning: the escalation ladder that turns "overdue" into "paid".
 *
 * Design rules that matter more than the copy:
 *  1. **Idempotent.** Every stage is recorded on the invoice. Re-running the
 *     job never double-sends, so a cron every 5 minutes is safe.
 *  2. **No catch-up spam.** If the job was down for a month and four stages are
 *     now due, you send the *furthest-along* one and record the earlier ones as
 *     `skipped`. A customer should never receive four backlogged nag emails in
 *     one minute.
 *  3. **Late fees apply once.** The fee is a term of the contract, not a
 *     message: it lands as soon as the stage that declares it is *due*, even
 *     if that email was superseded by a later one. Otherwise a week of job
 *     downtime would quietly change what you are entitled to bill.
 *  4. **Paid and void invoices are never touched.**
 */
import { formatCents as money } from './money.mjs';

/** Escalation ladder. Swap it per-customer by passing a policy. */
export const DEFAULT_POLICY = [
  {
    stage: 'nudge',
    atDaysOverdue: 1,
    tone: 'friendly',
    subject: 'Quick nudge: invoice {number} ({amount})',
    body: 'Hi {customer},\n\nInvoice {number} for {amount} came due on {dueDate}.\nIt may have slipped through — here is a one-click link to settle it:\n\n{link}\n\nNo action needed if payment is already on its way.',
  },
  {
    stage: 'reminder',
    atDaysOverdue: 7,
    tone: 'neutral',
    subject: 'Invoice {number} is {daysOverdue} days past due',
    body: 'Hi {customer},\n\nInvoice {number} for {amount} was due on {dueDate} and is now {daysOverdue} days overdue.\n\nPay here: {link}\n\nIf something is wrong with the invoice, reply and tell me — I would rather fix it than keep reminding you.',
  },
  {
    stage: 'firm',
    atDaysOverdue: 14,
    tone: 'firm',
    lateFeeBps: 150, // 1.5% late fee, applied once
    subject: 'Past due: invoice {number} — late fee applies',
    body: 'Hi {customer},\n\nInvoice {number} is {daysOverdue} days overdue. Per our terms a {lateFee} late fee has been applied,\nbringing the balance to {balance}.\n\nSettle here: {link}\n\nIf we have the wrong billing contact, forward this and tell me who to speak with.',
  },
  {
    stage: 'final',
    atDaysOverdue: 21,
    tone: 'final',
    escalate: true,
    subject: 'Final notice before collections: invoice {number}',
    body: 'Hi {customer},\n\nInvoice {number} ({balance}) is {daysOverdue} days overdue and is now the oldest item on our books.\n\nPay: {link}\n\nWithout payment or a reply within 7 days this goes to collections. I would much rather resolve it\nwith you directly — a payment plan is fine, just reply.',
  },
];

const FOOTER = '\n\n— {fromName}\nSent about invoice {number}. If this reached the wrong person, reply "wrong contact".';

/** @param {string} template @param {Record<string,string>} vars */

/**
 * Pure planning step: which stages are due for this invoice right now.
 * @returns {{due: any[], alreadySent: string[]}}
 */
export function dueStages(invoice, store, { now = new Date(), policy = DEFAULT_POLICY } = {}) {
  const alreadySent = Object.keys(invoice.dunning ?? {});
  if (invoice.status !== 'open') return { due: [], alreadySent };
  const overdue = store.daysOverdue(invoice, now);
  const due = policy.filter((s) => overdue >= s.atDaysOverdue && !alreadySent.includes(s.stage));
  return { due, alreadySent };
}

/**
 * Decide what to actually send: only the furthest-along due stage.
 * @returns {{send: any|null, skip: any[]}}
 */
export function pick({ due }) {
  if (due.length === 0) return { send: null, skip: [] };
  return { send: due[due.length - 1], skip: due.slice(0, -1) };
}

/** @returns {{to:string, from:string, subject:string, text:string, invoiceId:string, stage:string}} */
export function buildMessage(invoice, stage, { store, link, fromName, lateFeeCents = 0, now = new Date() }) {
  const balance = store.amountDueCents(invoice) + lateFeeCents;
  const vars = {
    number: invoice.number,
    customer: invoice.customer.name || 'there',
    amount: money(invoice.amountCents, invoice.currency),
    balance: money(balance, invoice.currency),
    lateFee: money(lateFeeCents, invoice.currency),
    dueDate: new Date(invoice.dueAt).toISOString().slice(0, 10),
    daysOverdue: String(store.daysOverdue(invoice, now)),
    link,
    fromName,
  };
  return {
    to: invoice.customer.email,
    from: fromName,
    subject: render(stage.subject, vars),
    text: render(stage.body, vars) + render(FOOTER, vars),
    invoiceId: invoice.id,
    stage: stage.stage,
    priority: stage.escalate ? 'high' : 'normal',
  };
}

/**
 * Run the ladder across every open invoice.
 *
 * @param {import('./store.mjs').Store} store
 * @param {{now?:Date, policy?:any[], send?:(msg:any)=>Promise<any>, linkFactory?:(i:any)=>Promise<string>|string,
 *          fromName?:string, dryRun?:boolean}} opts
 */
export async function runDunning(store, opts = {}) {
  const {
    now = new Date(),
    policy = DEFAULT_POLICY,
    send = null,
    linkFactory = null,
    fromName = process.env.SENDER_NAME ?? 'Accounts Receivable',
    dryRun = false,
  } = opts;

  const summary = { considered: 0, sent: [], skipped: [], wouldSend: [], failed: [], lateFeesCents: 0 };

  for (const invoice of store.listInvoices({ status: 'open' })) {
    summary.considered += 1;
    const due = dueStages(invoice, store, { now, policy }).due;
    const plan = pick({ due });
    if (!plan.send) continue;

    const link = linkFactory ? await linkFactory(invoice) : `https://pay.example.invalid/${invoice.id}`;

    // Record the stages we deliberately did NOT send, so they can never fire later.
    for (const skipped of plan.skip) {
      summary.skipped.push({ invoiceId: invoice.id, stage: skipped.stage });
      if (!dryRun) store.markDunning(invoice.id, skipped.stage, { at: now.toISOString(), disposition: 'skipped' });
    }

    // Late fee: once, as soon as the fee-declaring stage is due.
    const feeStage = [...due].reverse().find((s) => s.lateFeeBps);
    let lateFeeCents = 0;
    if (feeStage && invoice.lateFeeCents === 0) {
      lateFeeCents = Math.round((invoice.amountCents * feeStage.lateFeeBps) / 10_000);
      summary.lateFeesCents += lateFeeCents;
      if (!dryRun) invoice.lateFeeCents = lateFeeCents;
    }

    const message = buildMessage(invoice, plan.send, { store, link, fromName, lateFeeCents, now });
    if (dryRun) {
      summary.wouldSend.push({ invoiceId: invoice.id, stage: plan.send.stage, subject: message.subject });
      continue;
    }

    try {
      if (send) await send(message);
      store.markDunning(invoice.id, plan.send.stage);
      store.addEvent('dunning.sent', { invoiceId: invoice.id, stage: plan.send.stage });
      summary.sent.push({ invoiceId: invoice.id, stage: plan.send.stage, subject: message.subject });
    } catch (err) {
      // A failed send must NOT be recorded as sent, or the customer never hears
      // from us again. Leave the stage unmarked so the next run retries it.
      summary.failed.push({ invoiceId: invoice.id, stage: plan.send.stage, error: String(err?.message ?? err) });
    }
  }

  if (!dryRun) store.save();
  return summary;
}

export function render(template, vars) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}
