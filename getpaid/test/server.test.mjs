/**
 * End-to-end HTTP tests against a real server on an ephemeral port, using the
 * real fetch client. These exercise the paths that actually move money:
 * create -> chase -> pay -> webhook -> report.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { createMailer, readOutbox } from '../src/mailer.mjs';
import { startServer } from '../src/server.mjs';

const NOW = new Date('2026-02-01T09:00:00.000Z');
const DAY = 86_400_000;
const WEBHOOK_SECRET = 'whsec_e2e_secret';

let server;
let base;
let store;
let outboxDir;
let tmpDir;

const due = (days) => new Date(NOW.getTime() + days * DAY).toISOString();
const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'getpaid-http-'));
  outboxDir = join(tmpDir, 'outbox');
  store = new Store(join(tmpDir, 'ledger.json'));
  const env = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, CRON_SECRET: 'cron_s3cret' };
  const mailer = createMailer({ outboxDir, env: {} });
  const started = await startServer({ store, mailer, env, now: () => NOW });
  server = started.server;
  base = started.url;
});

after(() => {
  server?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('health check reports the modes in force', async () => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.paymentMode, 'mock');
  assert.equal(body.mailMode, 'file');
});

test('the dashboard renders as HTML and says mock mode out loud', async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(html, /Mock payment mode/);
  assert.match(html, /Receivables ageing/);
});

test('invoices can be created and listed with their live balance', async () => {
  const created = await (await post('/api/invoices', {
    customer: { name: 'Dana Ruiz', email: 'dana@example.com' },
    amountCents: 125000,
    dueAt: due(-30),
  })).json();
  assert.equal(created.invoice.amountCents, 125000);
  assert.equal(created.invoice.amountDueCents, 125000);

  const list = await (await fetch(`${base}/api/invoices?status=open`)).json();
  assert.equal(list.invoices.length, 1);
  assert.equal(list.invoices[0].daysOverdue, 30);
});

test('a bad invoice payload is rejected rather than half-created', async () => {
  const res = await post('/api/invoices', { customer: { email: 'a@b.c' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /dueAt/);
});

test('the dunning endpoint requires the cron secret when one is configured', async () => {
  const denied = await post('/api/dunning/run', {});
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'invalid_cron_secret');

  const allowed = await post('/api/dunning/run', {}, { authorization: 'Bearer cron_s3cret' });
  assert.equal(allowed.status, 200);
  const summary = await allowed.json();
  assert.equal(summary.sent.length, 1);
  assert.equal(summary.sent[0].stage, 'final');
});

test('the dunning run actually wrote a readable message to the outbox', () => {
  const messages = readOutbox(outboxDir);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].headers.to, 'dana@example.com');
  assert.match(messages[0].headers.subject, /Final notice/);
  assert.match(messages[0].body, /pay\.mock\.local/);
});

test('a payment link is created for the outstanding balance only', async () => {
  const invoice = store.listInvoices({ status: 'open' })[0];
  const res = await post(`/api/invoices/${invoice.id}/pay`, {});
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.mode, 'mock');
  assert.equal(body.warning, 'mock_mode_no_money_moves');
  assert.equal(body.amountCents, 126875, 'includes the 1.5% late fee applied by the final-notice run');
  assert.match(body.paymentLink, /^https:\/\/pay\.mock\.local\//);
});

test('an unsigned webhook is refused when a secret is configured', async () => {
  const res = await post('/api/webhooks/stripe', { type: 'checkout.session.completed' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'missing_signature_header');
});

test('a wrongly signed webhook is refused', async () => {
  const payload = JSON.stringify({ type: 'checkout.session.completed' });
  const res = await fetch(`${base}/api/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${Math.floor(NOW.getTime() / 1000)},v1=deadbeef`,
    },
    body: payload,
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).reason, 'signature_mismatch');
});

test('a correctly signed webhook settles the invoice and the report shows the recovery', async () => {
  const invoice = store.listInvoices({ status: 'open' })[0];
  const amount = store.amountDueCents(invoice);
  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_e2e', payment_status: 'paid', amount_total: amount, metadata: { invoice_id: invoice.id } } },
  });
  const t = Math.floor(NOW.getTime() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');

  const res = await fetch(`${base}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
    body: payload,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.applied, true);
  assert.equal(body.verifiedBy, 'ok');

  const report = await (await fetch(`${base}/api/report`)).json();
  assert.equal(report.recoveredCents, amount);
  assert.equal(report.outstandingCents, 0);
  assert.equal(report.recoveryRateBps, 10000);
});

test('a settled invoice cannot be paid again', async () => {
  const invoice = store.listInvoices({ status: 'paid' })[0];
  const res = await post(`/api/invoices/${invoice.id}/pay`, {});
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'nothing_due');
});

test('subscription checkout is offered for real plans only', async () => {
  const ok = await post('/api/subscribe', { planId: 'growth', interval: 'year' });
  const body = await ok.json();
  assert.equal(ok.status, 201);
  assert.equal(body.amountCents, 99000);
  assert.match(body.url, /subscribe\/growth\/year/);

  const bad = await post('/api/subscribe', { planId: 'enterprise-free' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'unknown_plan');
});

test('pricing page and unknown routes behave', async () => {
  const pricing = await fetch(`${base}/pricing`);
  assert.equal(pricing.status, 200);
  assert.match(await pricing.text(), /Starter/);

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'not_found');
});

test('an HTML form post to /api/subscribe redirects to the checkout', async () => {
  const res = await fetch(`${base}/api/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'planId=starter&interval=month',
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /subscribe\/starter\/month/);
});
