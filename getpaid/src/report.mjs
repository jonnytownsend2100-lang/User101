/**
 * Reporting: the numbers that tell you whether this app is worth its own
 * subscription — and, for the end customer, whether it paid for itself.
 *
 * The headline metric is **recovered cents**: money that was sitting overdue
 * and is now banked. That is the value the product delivers, and it is also the
 * honest way to price it (recovered >> subscription, or the customer churns).
 */
import { sumCents, ratioBps } from './money.mjs';
import { mrrCents } from './billing.mjs';

const DAY = 86_400_000;

/** Standard receivables ageing buckets. */
export function ageingBuckets(store, { now = new Date() } = {}) {
  const buckets = [
    { key: 'current', label: 'Not yet due', min: -Infinity, max: 0, count: 0, cents: 0 },
    { key: '1-7', label: '1–7 days', min: 1, max: 7, count: 0, cents: 0 },
    { key: '8-14', label: '8–14 days', min: 8, max: 14, count: 0, cents: 0 },
    { key: '15-30', label: '15–30 days', min: 15, max: 30, count: 0, cents: 0 },
    { key: '31+', label: '31+ days', min: 31, max: Infinity, count: 0, cents: 0 },
  ];
  for (const invoice of store.listInvoices({ status: 'open' })) {
    const due = store.amountDueCents(invoice);
    const overdue = store.daysOverdue(invoice, now);
    const bucket = buckets.find((b) => overdue >= b.min && overdue <= b.max) ?? buckets[0];
    bucket.count += 1;
    bucket.cents += due;
  }
  return buckets;
}

/**
 * @param {import('./store.mjs').Store} store
 * @param {{now?:Date, windowDays?:number}} opts
 */
export function buildReport(store, { now = new Date(), windowDays = 30 } = {}) {
  const invoices = store.listInvoices();
  const open = invoices.filter((i) => i.status === 'open');
  const paid = invoices.filter((i) => i.status === 'paid');
  const since = new Date(now.getTime() - windowDays * DAY).toISOString();
  const collected = sumCents(store.data.payments.map((p) => p.cents));

  const outstandingCents = sumCents(open.map((i) => store.amountDueCents(i)));
  const overdueCents = sumCents(
    open.filter((i) => store.daysOverdue(i, now) > 0).map((i) => store.amountDueCents(i)),
  );

  // Everything ever billed, so the recovery rate has a fixed denominator.
  // Late fees count as billed: they are money the customer owes, and leaving
  // them out lets the rate exceed 100% and stop meaning anything.
  const billedCents = sumCents(
    invoices.filter((i) => i.status !== 'void').map((i) => i.amountCents + (i.lateFeeCents ?? 0)),
  );

  const daysToPay = paid
    .filter((i) => i.paidAt)
    .map((i) => (new Date(i.paidAt).getTime() - new Date(i.dueAt).getTime()) / DAY);

  return {
    generatedAt: now.toISOString(),
    windowDays,
    counts: { total: invoices.length, open: open.length, paid: paid.length, voided: invoices.filter((i) => i.status === 'void').length },
    outstandingCents,
    overdueCents,
    billedCents,
    collectedCents: collected,
    recoveredCents: collected,
    recoveredInWindowCents: sumCents(store.data.payments.filter((p) => p.at >= since).map((p) => p.cents)),
    recoveredInWindowCount: store.data.payments.filter((p) => p.at >= since).length,
    recoveryRateBps: ratioBps(collected, billedCents),
    avgDaysLateDays: daysToPay.length ? round1(daysToPay.reduce((a, b) => a + b, 0) / daysToPay.length) : null,
    fastestPaymentDays: daysToPay.length ? Math.round(Math.min(...daysToPay)) : null,
    dunning: {
      sent: store.listEvents().filter((e) => e.type === 'dunning.sent').length,
      sentInWindow: store.listEvents({ since }).filter((e) => e.type === 'dunning.sent').length,
    },
    ageing: ageingBuckets(store, { now }),
    subscriptions: {
      active: store.listSubscriptions().filter((s) => s.status === 'active').length,
      mrrCents: mrrCents(store),
      arrCents: mrrCents(store) * 12,
    },
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** One-line text summary for the CLI. */
export function formatReport(report) {
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  return [
    `Recovered (all time): ${money(report.recoveredCents)}  |  last ${report.windowDays}d: ${money(report.recoveredInWindowCents)} (${report.recoveredInWindowCount} payments)`,
    `Outstanding: ${money(report.outstandingCents)} across ${report.counts.open} open invoices  |  overdue: ${money(report.overdueCents)}`,
    `Recovery rate: ${(report.recoveryRateBps / 100).toFixed(1)}% of ${money(report.billedCents)} billed`,
    `Avg days late when settled: ${report.avgDaysLateDays ?? 'n/a'}${report.avgDaysLateDays === null ? '' : ' (negative = paid early)'}`,
    `Dunning emails: ${report.dunning.sent} total, ${report.dunning.sentInWindow} in window`,
    `App MRR: ${money(report.subscriptions.mrrCents)} from ${report.subscriptions.active} subscriptions`,
  ].join('\n');
}
