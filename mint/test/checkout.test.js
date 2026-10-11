import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { defineProduct } from '../lib/catalog.js';
import { createOrder, markPaid, refund, upsertCustomer } from '../lib/checkout.js';
import { mock, stripe } from '../lib/providers.js';
import { verifyLicense } from '../lib/license.js';

const secret = 'test-license-secret';
const baseUrl = 'http://localhost:8787';

function fixture({ fee = mock.fee } = {}) {
  const store = new Store();
  const product = defineProduct(store, { name: 'Widget', price: 25, interval: 'month', seats: 2 });
  const oneOff = defineProduct(store, { name: 'Ebook', price: 9 });
  const pwyw = defineProduct(store, { name: 'Tip', price: 5, payWhatYouWant: true, minimumAmount: 500 });
  return { store, product, oneOff, pwyw, provider: { ...mock, fee } };
}

test('checkout creates a pending order with fee and net', async () => {
  const { store, product, provider } = fixture({ fee: { bps: 290, fixed: 30 } });
  const order = await createOrder(store, { productId: product.slug, email: 'A@Example.com', provider, baseUrl });
  assert.equal(order.status, 'pending');
  assert.equal(order.amount, 2500);
  assert.equal(order.fee, 103);
  assert.equal(order.net, 2397);
  assert.equal(order.email, 'a@example.com');
  assert.equal(order.checkoutUrl, `${baseUrl}/pay/${order.id}`);
  assert.ok(order.claimToken.startsWith('tok_'));
});

test('paying issues a license that verifies', async () => {
  const { store, product, provider } = fixture();
  const order = await createOrder(store, { productId: product.slug, email: 'a@b.co', provider, baseUrl });
  const { order: paid, license, duplicate } = await markPaid(store, order.id, { licenseSecret: secret });
  assert.equal(paid.status, 'paid');
  assert.equal(duplicate, false);
  assert.equal(license.status, 'active');
  const check = verifyLicense(license.key, { secret });
  assert.equal(check.valid, true);
  assert.equal(check.payload.seats, 2);
  assert.equal(store.find('customers', order.customerId).lifetimeValue, 2500);
});

test('webhook retries are idempotent', async () => {
  const { store, product, provider } = fixture();
  const order = await createOrder(store, { productId: product.slug, email: 'a@b.co', provider, baseUrl });
  const first = await markPaid(store, order.id, { licenseSecret: secret });
  const second = await markPaid(store, order.id, { licenseSecret: secret });
  assert.equal(second.duplicate, true);
  assert.equal(second.license.id, first.license.id);
  assert.equal(store.all('licenses').length, 1);
  assert.equal(store.find('customers', order.customerId).orders, 1);
});

test('underpayment is refused', async () => {
  const { store, product, provider } = fixture();
  const order = await createOrder(store, { productId: product.slug, email: 'a@b.co', provider, baseUrl });
  await assert.rejects(() => markPaid(store, order.id, { amountMinor: 100, licenseSecret: secret }), /underpaid/);
  assert.equal(store.find('orders', order.id).status, 'pending');
});

test('a refund revokes the license and corrects lifetime value', async () => {
  const { store, product, provider } = fixture();
  const order = await createOrder(store, { productId: product.slug, email: 'a@b.co', provider, baseUrl });
  const { license } = await markPaid(store, order.id, { licenseSecret: secret });
  const refunded = await refund(store, order.id, { reason: 'changed mind' });
  assert.equal(refunded.status, 'refunded');
  assert.equal(store.find('licenses', license.id).status, 'revoked');
  assert.equal(store.find('customers', order.customerId).lifetimeValue, 0);
  assert.equal(verifyLicense(license.key, { secret }).valid, true, 'signature still valid; revocation is a store lookup');
});

test('refunds only apply to paid orders', async () => {
  const { store, product, provider } = fixture();
  const order = await createOrder(store, { productId: product.slug, email: 'a@b.co', provider, baseUrl });
  await assert.rejects(() => refund(store, order.id), /only paid orders/);
});

test('pay-what-you-want is floored at the minimum', async () => {
  const { store, pwyw, provider } = fixture();
  await assert.rejects(
    () => createOrder(store, { productId: pwyw.id, email: 'a@b.co', amountMinor: 100, provider, baseUrl }),
    /amount must be an integer/,
  );
  const order = await createOrder(store, { productId: pwyw.id, email: 'a@b.co', amountMinor: 7500, provider, baseUrl });
  assert.equal(order.amount, 7500);
});

test('fixed-price products reject an override', async () => {
  const { store, oneOff, provider } = fixture();
  await assert.rejects(
    () => createOrder(store, { productId: oneOff.id, email: 'a@b.co', amountMinor: 1, provider, baseUrl }),
    /fixed price/,
  );
});

test('quantity multiplies and is capped', async () => {
  const { store, oneOff, provider } = fixture();
  const order = await createOrder(store, { productId: oneOff.id, email: 'a@b.co', quantity: 3, provider, baseUrl });
  assert.equal(order.amount, 2700);
  const capped = await createOrder(store, { productId: oneOff.id, email: 'a@b.co', quantity: 100000, provider, baseUrl });
  assert.equal(capped.quantity, 100);
});

test('bad email and unknown product are rejected', async () => {
  const { store, product, provider } = fixture();
  await assert.rejects(() => createOrder(store, { productId: product.id, email: 'nope', provider, baseUrl }), /valid customer email/);
  await assert.rejects(() => createOrder(store, { productId: 'ghost', email: 'a@b.co', provider, baseUrl }), /no such product/);
});

test('a failing provider marks the order failed, not paid', async () => {
  const { store, product } = fixture();
  const broken = { ...mock, name: 'broken', createCheckout: async () => { throw new Error('gateway down'); } };
  await assert.rejects(() => createOrder(store, { productId: product.id, email: 'a@b.co', provider: broken, baseUrl }), /gateway down/);
  assert.equal(store.all('orders')[0].status, 'failed');
});

test('stripe checkout is built with the right session parameters', async () => {
  const { store, product } = fixture();
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init, form: new URLSearchParams(init.body) };
    return { ok: true, json: async () => ({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) };
  };
  const order = await createOrder(store, {
    productId: product.id, email: 'a@b.co', provider: stripe, baseUrl, secretKey: 'sk_test_x', fetchImpl: fakeFetch,
  });
  assert.equal(captured.form.get('mode'), 'subscription');
  assert.equal(captured.form.get('line_items[0][price_data][unit_amount]'), '2500');
  assert.equal(captured.form.get('line_items[0][price_data][recurring][interval]'), 'month');
  assert.equal(captured.form.get('client_reference_id'), order.id);
  assert.match(captured.form.get('success_url'), new RegExp(`t=${order.claimToken}$`));
  assert.equal(order.providerRef, 'cs_test_1');
  assert.equal(order.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_1');
});

test('stripe without a key fails loudly', async () => {
  const { store, product } = fixture();
  await assert.rejects(
    () => createOrder(store, { productId: product.id, email: 'a@b.co', provider: stripe, baseUrl, secretKey: null }),
    /STRIPE_SECRET_KEY/,
  );
});

test('upsertCustomer reuses the same record across orders', () => {
  const store = new Store();
  const first = upsertCustomer(store, 'x@y.co');
  const second = upsertCustomer(store, 'X@Y.co');
  assert.equal(first.id, second.id);
  assert.equal(store.all('customers').length, 1);
});
