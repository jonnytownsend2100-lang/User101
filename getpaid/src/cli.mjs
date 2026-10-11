#!/usr/bin/env node
/**
 * CLI. `node src/cli.mjs demo` is the fastest way to see the whole machine
 * work end to end without any credentials.
 */
import { parseArgs } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openStore } from './store.mjs';
import { runDunning, DEFAULT_POLICY } from './dunning.mjs';
import { createCheckoutSession, applyStripeEvent, stripeMode } from './payments.mjs';
import { createMailer, mailerMode, readOutbox } from './mailer.mjs';
import { createSubscriptionCheckout } from './billing.mjs';
import { buildReport, formatReport } from './report.mjs';
import { startServer } from './server.mjs';
import { toCents, formatCents } from './money.mjs';

const ROOT = process.env.GETPAID_HOME ? resolve(process.env.GETPAID_HOME) : resolve(process.cwd(), 'getpaid-data');
const dataFile = process.env.DATA_FILE ?? join(ROOT, 'ledger.json');
const outboxDir = process.env.OUTBOX_DIR ?? join(ROOT, 'outbox');

const DAY = 86_400_000;
const iso = (d) => d.toISOString();
const shift = (days, from = new Date()) => iso(new Date(from.getTime() + days * DAY));

const OPTIONS = {
  now: { type: 'string' },
  'dry-run': { type: 'boolean' },
  email: { type: 'string' },
  amount: { type: 'string' },
  due: { type: 'string' },
  number: { type: 'string' },
  name: { type: 'string' },
  plan: { type: 'string' },
  interval: { type: 'string' },
  port: { type: 'string' },
  'dunning-every': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `getpaid <command>

  init                      create the ledger + outbox
  seed [--now=ISO]          insert demo invoices with realistic ageing
  add-invoice --email --amount --due [--number] [--name]
  run-dunning [--dry-run] [--now=ISO]
  outbox                    list messages written to the file outbox
  report                    print the recovery report
  pay <invoiceId>           create a payment link for an invoice
  subscribe [--plan --interval]   create a subscription checkout (the app's revenue)
  serve [--port=8787] [--dunning-every=60000]
  demo                      full end-to-end run on a throwaway ledger

Environment: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, RESEND_API_KEY, EMAIL_FROM,
             ADMIN_TOKEN, CRON_SECRET, DATA_FILE, OUTBOX_DIR, GETPAID_HOME`;

function seed(store, now = new Date()) {
  const invoices = [
    { number: 'INV-1001', customer: { name: 'Dana Ruiz', email: 'dana@northwind.example' }, amountCents: toCents('2400.00'), dueAt: shift(-21, now) },
    { number: 'INV-1002', customer: { name: 'Sam Okafor', email: 'sam@brightloop.example' }, amountCents: toCents('815.50'), dueAt: shift(-10, now) },
    { number: 'INV-1003', customer: { name: 'Priya Nair', email: 'priya@lumenlabs.example' }, amountCents: toCents('12500.00'), dueAt: shift(-3, now) },
    { number: 'INV-1004', customer: { name: 'Tomas Berg', email: 'tomas@fjordline.example' }, amountCents: toCents('430.00'), dueAt: shift(6, now) },
    { number: 'INV-1005', customer: { name: 'Aisha Khan', email: 'aisha@meridian.example' }, amountCents: toCents('3100.00'), dueAt: shift(-40, now) },
  ];
  const created = invoices.map((i) => store.addInvoice(i));
  // One invoice already settled, so the recovery-rate denominator is non-zero.
  store.recordPayment(created[4].id, created[4].amountCents, { method: 'seed', at: iso(now) });
  store.save();
  return created;
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true, args: process.argv.slice(2) });
  const command = positionals[0] ?? 'help';
  const now = values.now ? new Date(values.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`bad --now: ${values.now}`);
  if (values.help || command === 'help') return console.log(HELP);

  if (command === 'init') {
    const store = openStore(dataFile);
    store.save();
    console.log(`ledger: ${dataFile}\noutbox: ${outboxDir}`);
    console.log(`payment mode: ${stripeMode()} | mail mode: ${mailerMode()}`);
    return;
  }

  if (command === 'demo') return demo();

  const store = openStore(dataFile);

  if (command === 'seed') {
    const created = seed(store, now);
    console.log(`seeded ${created.length} invoices into ${dataFile}`);
    console.log(`overdue now: ${created.filter((i) => store.daysOverdue(i, now) > 0).length}`);
    return;
  }

  if (command === 'add-invoice') {
    if (!values.email || !values.amount || !values.due) throw new Error('--email, --amount and --due are required');
    const invoice = store.addInvoice({
      number: values.number,
      customer: { name: values.name ?? '', email: values.email },
      amountCents: toCents(values.amount),
      dueAt: values.due,
    });
    store.save();
    console.log(`${invoice.id}  ${invoice.number}  ${formatCents(invoice.amountCents)}  due ${invoice.dueAt}`);
    return;
  }

  if (command === 'run-dunning') return runDunningCli(store, now, values);

  if (command === 'outbox') {
    const messages = readOutbox(outboxDir);
    if (messages.length === 0) return console.log(`outbox is empty (${outboxDir})`);
    for (const m of messages) console.log(`${m.headers['x-getpaid-stage']}  ->  ${m.headers.to}  ::  ${m.headers.subject}`);
    return console.log(`\n${messages.length} messages in ${outboxDir}`);
  }

  if (command === 'report') return console.log(formatReport(buildReport(store, { now })));

  if (command === 'policy') return console.log(JSON.stringify(DEFAULT_POLICY, null, 2));

  if (command === 'pay') {
    const invoice = store.getInvoice(positionals[1] ?? '');
    if (!invoice) throw new Error(`no such invoice: ${positionals[1]}`);
    const session = await createCheckoutSession(invoice, store.amountDueCents(invoice));
    console.log(`${session.mode}  ${session.url}`);
    return;
  }

  if (command === 'subscribe') {
    const checkout = await createSubscriptionCheckout(values.plan ?? 'growth', {
      interval: values.interval === 'year' ? 'year' : 'month',
    });
    console.log(`${checkout.mode}  ${checkout.planId}/${checkout.interval}  ${formatCents(checkout.amountCents)}  ${checkout.url}`);
    return;
  }

  if (command === 'serve') return serveCli(store, values);

  throw new Error(`unknown command: ${command}\n\n${HELP}`);
}

async function runDunningCli(store, now, values) {
  const mailer = createMailer({ outboxDir });
  const summary = await runDunning(store, {
    now,
    dryRun: values['dry-run'] === true,
    send: (msg) => mailer.send(msg),
    linkFactory: (invoice) => createCheckoutSession(invoice, store.amountDueCents(invoice)).then((s) => s.url),
  });
  console.log(`considered ${summary.considered} open invoices`);
  for (const s of summary.sent) console.log(`  SENT   ${s.invoiceId}  ${s.stage}  ::  ${s.subject}`);
  for (const s of summary.wouldSend) console.log(`  DRY    ${s.invoiceId}  ${s.stage}  ::  ${s.subject}`);
  for (const s of summary.skipped) console.log(`  SKIP   ${s.invoiceId}  ${s.stage} (older stage, superseded)`);
  for (const s of summary.failed) console.log(`  FAIL   ${s.invoiceId}  ${s.stage}  ${s.error}`);
  console.log(`late fees applied: ${formatCents(summary.lateFeesCents)} | messages: ${mailerMode() === 'file' ? outboxDir : 'resend'}`);
}

async function serveCli(store, values) {
  const mailer = createMailer({ outboxDir, env: process.env });
  const port = Number(values.port ?? process.env.PORT ?? 8787);
  const { url, server } = await startServer({ store, mailer, port, host: process.env.HOST ?? '127.0.0.1' });
  console.log(`dashboard: ${url}`);
  console.log(`payment mode: ${stripeMode()} | mail mode: ${mailer.mode}`);

  const every = Number(values['dunning-every'] ?? 0);
  if (every > 0) {
    // In-process scheduler so the app is useful without cron. On Vercel you
    // would drop this and let Cron hit POST /api/dunning/run instead.
    const tick = async () => {
      const summary = await runDunning(store, { send: (m) => mailer.send(m) });
      if (summary.sent.length) console.log(`[dunning] sent ${summary.sent.length}`);
    };
    const timer = setInterval(tick, every);
    timer.unref();
    server.on('close', () => clearInterval(timer));
    console.log(`dunning every ${every}ms`);
  }
  return server;
}

/** End-to-end proof on a throwaway ledger: seed, chase, get paid, report. */
async function demo() {
  const dir = mkdtempSync(join(tmpdir(), 'getpaid-demo-'));
  try {
    const store = openStore(join(dir, 'ledger.json'));
    const mailer = createMailer({ outboxDir: join(dir, 'outbox') });
    const now = new Date();
    seed(store, now);

    console.log('== 1. chase the overdue invoices ==');
    const first = await runDunning(store, { now, send: (m) => mailer.send(m) });
    console.log(`sent ${first.sent.length} messages, applied ${formatCents(first.lateFeesCents)} in late fees`);

    console.log('\n== 2. two weeks later, the ladder has escalated ==');
    const later = new Date(now.getTime() + 14 * DAY);
    const second = await runDunning(store, { now: later, send: (m) => mailer.send(m) });
    for (const s of second.sent) console.log(`  ${s.stage.padEnd(8)} -> ${s.subject}`);

    console.log('\n== 3. the biggest invoice gets paid (Stripe webhook path) ==');
    const biggest = store.listInvoices({ status: 'open' }).sort((a, b) => b.amountCents - a.amountCents)[0];
    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_demo_1', payment_status: 'paid', amount_total: store.amountDueCents(biggest), metadata: { invoice_id: biggest.id } } },
    };
    console.log(`  webhook applied: ${JSON.stringify(applyStripeEvent(store, event))}`);
    store.save();

    console.log('\n== 4. report ==');
    console.log(formatReport(buildReport(store, { now: later })));
    console.log(`\noutbox: ${readOutbox(join(dir, 'outbox')).length} .eml files written to ${join(dir, 'outbox')}`);
    console.log('demo ledger was temporary and has been deleted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});


