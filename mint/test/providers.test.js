import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { getProvider, mock, stripe } from '../lib/providers.js';

const secret = 'whsec_test';
const sign = (rawBody, t, key = secret) => createHmac('sha256', key).update(`${t}.${rawBody}`).digest('hex');

test('getProvider resolves known names and refuses unknown ones', () => {
  assert.equal(getProvider('mock'), mock);
  assert.equal(getProvider('stripe'), stripe);
  assert.throws(() => getProvider('paypal'), /unknown provider/);
  assert.throws(() => getProvider('mock', { allowMock: false }), /mock provider disabled/);
});

test('a correctly signed stripe webhook verifies', () => {
  const rawBody = JSON.stringify({ type: 'checkout.session.completed' });
  const t = Math.floor(Date.now() / 1000);
  assert.equal(stripe.verifySignature({ rawBody, header: `t=${t},v1=${sign(rawBody, t)}`, secret }), true);
});

test('a stripe signature from the wrong secret is rejected', () => {
  const rawBody = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  assert.throws(() => stripe.verifySignature({ rawBody, header: `t=${t},v1=${sign(rawBody, t, 'other')}`, secret }), /mismatch/);
});

test('a replayed stripe signature outside the tolerance window is rejected', () => {
  const rawBody = '{"a":1}';
  const t = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => stripe.verifySignature({ rawBody, header: `t=${t},v1=${sign(rawBody, t)}`, secret }), /tolerance/);
});

test('a tampered body invalidates the signature', () => {
  const t = Math.floor(Date.now() / 1000);
  const signed = JSON.stringify({ amount_total: 100 });
  const header = `t=${t},v1=${sign(signed, t)}`;
  assert.throws(() => stripe.verifySignature({ rawBody: JSON.stringify({ amount_total: 99999 }), header, secret }), /mismatch/);
});

test('stripe webhooks normalise into the internal event shape', async () => {
  const body = {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', client_reference_id: 'ord_1', amount_total: 2900 } },
  };
  const rawBody = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const event = await stripe.parseWebhook({ body, rawBody, header: `t=${t},v1=${sign(rawBody, t)}`, secret });
  assert.deepEqual(event, { type: 'paid', orderId: 'ord_1', providerRef: 'cs_1', amountMinor: 2900 });
});

test('refunds and unknown events are mapped without inventing orders', async () => {
  const refundBody = { type: 'charge.refunded', data: { object: { id: 'ch_1', metadata: { order_id: 'ord_9' }, amount_refunded: 100 } } };
  const raw = JSON.stringify(refundBody);
  const t = Math.floor(Date.now() / 1000);
  const refunded = await stripe.parseWebhook({ body: refundBody, rawBody: raw, header: `t=${t},v1=${sign(raw, t)}`, secret });
  assert.equal(refunded.type, 'refunded');
  assert.equal(refunded.orderId, 'ord_9');

  const other = { type: 'customer.created', data: { object: { id: 'cus_1' } } };
  const rawOther = JSON.stringify(other);
  const ignored = await stripe.parseWebhook({ body: other, rawBody: rawOther, header: `t=${t},v1=${sign(rawOther, t)}`, secret });
  assert.equal(ignored.type, 'ignored');
  assert.equal(ignored.orderId, undefined);
});

test('an unsigned stripe webhook cannot be parsed', async () => {
  await assert.rejects(() => stripe.parseWebhook({ body: {}, rawBody: '{}', header: '', secret }), /malformed stripe signature/);
  await assert.rejects(() => stripe.parseWebhook({ body: {}, rawBody: '{}', header: 't=1,v1=x', secret: null }), /STRIPE_WEBHOOK_SECRET/);
});

test('the mock provider returns a local, clickable checkout', async () => {
  const session = await mock.createCheckout({ order: { id: 'ord_1' }, baseUrl: 'http://x' });
  assert.equal(session.checkoutUrl, 'http://x/pay/ord_1');
  assert.equal(session.providerRef, 'mock_cs_ord_1');
});

test('the mock webhook needs an order id', async () => {
  await assert.rejects(() => mock.parseWebhook({ body: {} }), /requires orderId/);
  assert.equal((await mock.parseWebhook({ body: { orderId: 'ord_1' } })).type, 'paid');
  assert.equal((await mock.parseWebhook({ body: { orderId: 'ord_1', type: 'refunded' } })).type, 'refunded');
});
