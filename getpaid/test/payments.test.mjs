import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import {
  stripeMode,
  createCheckoutSession,
  verifyStripeSignature,
  applyStripeEvent,
  DEFAULT_TOLERANCE_SECONDS,
} from '../src/payments.mjs';

const NOW_MS = 1_800_000_000_000; // fixed clock for replay tests
const SECRET = 'whsec_test_abc123';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'getpaid-pay-'));
  const store = new Store(join(dir, 'ledger.json'));
  const inv = store.addInvoice({
    customer: { name: 'Dana', email: 'dana@example.com' },
    amountCents: 25000,
    dueAt: new Date(NOW_MS).toISOString(),
  });
  return { store, inv, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sign(payload, { secret = SECRET, timestamp = Math.floor(NOW_MS / 1000) } = {}) {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

test('stripeMode is decided by the environment, never by a flag in code', () => {
  assert.equal(stripeMode({}), 'mock');
  assert.equal(stripeMode({ STRIPE_SECRET_KEY: 'sk_test_x' }), 'live');
});

test('mock mode returns a fake link that is obviously fake', async () => {
  const { store, inv, cleanup } = harness();
  const session = await createCheckoutSession(inv, store.amountDueCents(inv), { env: {} });
  assert.equal(session.mode, 'mock');
  assert.match(session.url, /^https:\/\/pay\.mock\.local\//);
  assert.match(session.url, /amount=25000/);
  cleanup();
});

test('creating a link for a settled invoice is refused', async () => {
  const { store, inv, cleanup } = harness();
  await assert.rejects(() => createCheckoutSession(inv, 0, { env: {} }), /nothing due/);
  cleanup();
});

test('live mode posts the exact Stripe Checkout shape', async () => {
  const { store, inv, cleanup } = harness();
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, text: async () => JSON.stringify({ id: 'cs_123', url: 'https://checkout.stripe.com/c/pay/cs_123' }) };
  };

  const session = await createCheckoutSession(inv, 25000, {
    env: { STRIPE_SECRET_KEY: 'sk_live_xyz' },
    fetchImpl: fakeFetch,
    successUrl: 'https://app.example/paid',
    cancelUrl: 'https://app.example/cancel',
  });

  assert.equal(session.mode, 'live');
  assert.equal(session.url, 'https://checkout.stripe.com/c/pay/cs_123');
  assert.equal(captured.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk_live_xyz');
  const params = new URLSearchParams(captured.init.body);
  assert.equal(params.get('mode'), 'payment');
  assert.equal(params.get('line_items[0][price_data][unit_amount]'), '25000');
  assert.equal(params.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(params.get('metadata[invoice_id]'), inv.id);
  assert.equal(params.get('customer_email'), 'dana@example.com');
  cleanup();
});

test('a Stripe error surfaces instead of pretending the link exists', async () => {
  const { store, inv, cleanup } = harness();
  const fakeFetch = async () => ({ ok: false, status: 402, text: async () => '{"error":{"message":"card_declined"}}' });
  await assert.rejects(
    () => createCheckoutSession(inv, 25000, { env: { STRIPE_SECRET_KEY: 'sk_live_xyz' }, fetchImpl: fakeFetch }),
    /stripe checkout failed \(402\)/,
  );
  cleanup();
});

test('signature verification accepts a genuine signature', () => {
  const payload = '{"type":"checkout.session.completed"}';
  const result = verifyStripeSignature({ header: sign(payload), payload, secret: SECRET, nowMs: NOW_MS });
  assert.deepEqual(result, { valid: true, reason: 'ok', timestamp: Math.floor(NOW_MS / 1000) });
});

test('a tampered body invalidates the signature', () => {
  const payload = '{"amount":100}';
  const header = sign(payload);
  const tampered = '{"amount":999999}';
  const result = verifyStripeSignature({ header, payload: tampered, secret: SECRET, nowMs: NOW_MS });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('the wrong secret is rejected', () => {
  const payload = '{}';
  const result = verifyStripeSignature({ header: sign(payload, { secret: 'whsec_other' }), payload, secret: SECRET, nowMs: NOW_MS });
  assert.equal(result.reason, 'signature_mismatch');
});

test('old signatures are rejected (replay protection)', () => {
  const payload = '{}';
  const stale = Math.floor(NOW_MS / 1000) - DEFAULT_TOLERANCE_SECONDS - 1;
  const result = verifyStripeSignature({ header: sign(payload, { timestamp: stale }), payload, secret: SECRET, nowMs: NOW_MS });
  assert.equal(result.reason, 'timestamp_out_of_tolerance');
});

test('malformed and missing headers are rejected, and no secret means no trust', () => {
  assert.equal(verifyStripeSignature({ header: undefined, payload: '{}', secret: SECRET, nowMs: NOW_MS }).reason, 'missing_signature_header');
  assert.equal(verifyStripeSignature({ header: 'garbage', payload: '{}', secret: SECRET, nowMs: NOW_MS }).reason, 'malformed_signature_header');
  assert.equal(verifyStripeSignature({ header: 't=1', payload: '{}', secret: SECRET, nowMs: NOW_MS }).reason, 'malformed_signature_header');
  assert.equal(verifyStripeSignature({ header: sign('{}'), payload: '{}', secret: '', nowMs: NOW_MS }).reason, 'no_webhook_secret_configured');
});

test('a real payment marks the invoice paid and books the recovery', () => {
  const { store, inv, cleanup } = harness();
  const result = applyStripeEvent(store, {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 25000, metadata: { invoice_id: inv.id } } },
  });
  assert.deepEqual(result, { applied: true, invoiceId: inv.id, cents: 25000 });
  assert.equal(store.getInvoice(inv.id).status, 'paid');
  assert.equal(store.data.payments[0].reference, 'cs_1');
  cleanup();
});

test('a replayed webhook cannot double-book the payment', () => {
  const { store, inv, cleanup } = harness();
  const event = {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_status: 'paid', amount_total: 25000, metadata: { invoice_id: inv.id } } },
  };
  applyStripeEvent(store, event);
  const replay = applyStripeEvent(store, event);
  assert.deepEqual(replay, { applied: false, reason: 'already_paid' });
  assert.equal(store.data.payments.length, 1, 'exactly one payment recorded');
  cleanup();
});

test('incomplete, unknown and unattributable events change nothing', () => {
  const { store, inv, cleanup } = harness();
  const base = { type: 'checkout.session.completed', data: { object: {} } };
  assert.equal(applyStripeEvent(store, base).reason, 'no_invoice_id_in_metadata');
  assert.equal(applyStripeEvent(store, { ...base, data: { object: { metadata: { invoice_id: 'nope' } } } }).reason, 'unknown_invoice');
  assert.equal(
    applyStripeEvent(store, { ...base, data: { object: { metadata: { invoice_id: inv.id }, payment_status: 'unpaid' } } }).reason,
    'payment_status=unpaid',
  );
  assert.equal(applyStripeEvent(store, { type: 'customer.created', data: { object: {} } }).applied, false);
  assert.equal(store.getInvoice(inv.id).status, 'open');
  cleanup();
});

test('an overpayment is recorded and flagged, never swallowed', () => {
  const { store, inv, cleanup } = harness();
  const result = applyStripeEvent(store, {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_2', payment_status: 'paid', amount_total: 30000, metadata: { invoice_id: inv.id } } },
  });
  assert.equal(result.applied, true);
  assert.equal(result.warning, 'overpayment');
  assert.equal(store.getInvoice(inv.id).paidCents, 30000);
  assert.equal(store.listEvents().some((e) => e.type === 'payment.overpaid'), true);
  cleanup();
});
