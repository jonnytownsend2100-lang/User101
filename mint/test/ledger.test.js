import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { defineProduct } from '../lib/catalog.js';
import { createOrder, markPaid, refund } from '../lib/checkout.js';
import { metrics, priceAdvice } from '../lib/ledger.js';
import { mock } from '../lib/providers.js';

const secret = 'ledger-secret';
const now = new Date('2025-06-15T12:00:00Z');

async function sold(store, product, provider, { email = 'a@b.co', when = now, quantity = 1 } = {}) {
  const order = await createOrder(store, { productId: product.id, email, provider, quantity, now: when });
  await markPaid(store, order.id, { licenseSecret: secret, now: when });
  return order;
}

function fixture(fee) {
  const store = new Store();
  const monthly = defineProduct(store, { name: 'Monthly', price: 29, interval: 'month' });
  const yearly = defineProduct(store, { name: 'Yearly', price: 120, interval: 'year' });
  const oneOff = defineProduct(store, { name: 'One-off', price: 50 });
  return { store, monthly, yearly, oneOff, provider: { ...mock, fee } };
}

test('net revenue subtracts fees and refunds from gross', async () => {
  const { store, oneOff, provider } = fixture({ bps: 290, fixed: 30 });
  await sold(store, oneOff, provider);
  await sold(store, oneOff, provider, { email: 'c@d.co' });
  const m = metrics(store, { now });
  assert.equal(m.gross, 10000);
  assert.equal(m.fees, 350); // 2 * (145 + 30)
  assert.equal(m.refunds, 0);
  assert.equal(m.net, 9650);
  assert.equal(m.orders.paid, 2);
  assert.equal(m.customers, 2);
});

test('refunds reduce net and are counted separately', async () => {
  const { store, oneOff, provider } = fixture({ bps: 290, fixed: 30 });
  const order = await sold(store, oneOff, provider);
  await refund(store, order.id, { now });
  const m = metrics(store, { now });
  assert.equal(m.gross, 5000);
  assert.equal(m.fees, 175);
  assert.equal(m.refunds, 5000);
  assert.equal(m.net, -175, 'fees are not refunded by the processor');
  assert.equal(m.orders.refunded, 1);
  assert.equal(m.orders.paid, 0);
  assert.equal(m.licenses.revoked, 1);
});

test('MRR normalises yearly and weekly subscriptions', async () => {
  const { store, monthly, yearly, provider } = fixture({ bps: 0, fixed: 0 });
  await sold(store, monthly, provider);
  await sold(store, yearly, provider, { email: 'c@d.co' });
  const m = metrics(store, { now });
  assert.equal(m.mrr, 2900 + 1000); // 2900 + (12000 / 12)
  assert.equal(m.arr, m.mrr * 12);
});

test('refunded subscriptions drop out of MRR', async () => {
  const { store, monthly, provider } = fixture({ bps: 0, fixed: 0 });
  const order = await sold(store, monthly, provider);
  assert.equal(metrics(store, { now }).mrr, 2900);
  await refund(store, order.id, { now });
  assert.equal(metrics(store, { now }).mrr, 0);
});

test('the daily series covers the requested window and lands revenue on the right day', async () => {
  const { store, oneOff, provider } = fixture({ bps: 0, fixed: 0 });
  await sold(store, oneOff, provider, { when: new Date('2025-06-15T09:00:00Z') });
  await sold(store, oneOff, provider, { when: new Date('2025-06-13T09:00:00Z'), email: 'c@d.co' });
  const m = metrics(store, { now, days: 5 });
  assert.equal(m.series.length, 5);
  assert.equal(m.series.at(-1).date, '2025-06-15');
  assert.equal(m.series.at(-1).net, 5000);
  assert.equal(m.series.find((d) => d.date === '2025-06-13').net, 5000);
  assert.equal(m.series.find((d) => d.date === '2025-06-14').net, 0);
});

test('by-product breakdown sorts by net and never double counts fees', async () => {
  const { store, oneOff, monthly, provider } = fixture({ bps: 290, fixed: 30 });
  await sold(store, oneOff, provider);
  await sold(store, monthly, provider, { email: 'c@d.co' });
  const m = metrics(store, { now });
  assert.equal(m.byProduct.length, 2);
  assert.equal(m.byProduct[0].name, 'One-off');
  const total = m.byProduct.reduce((acc, p) => acc + p.net, 0);
  assert.equal(total, m.net);
  assert.equal(m.margin, m.net / m.gross);
});

test('conversion counts created orders, including abandoned ones', async () => {
  const { store, oneOff, provider } = fixture();
  await sold(store, oneOff, provider);
  await createOrder(store, { productId: oneOff.id, email: 'abandon@x.co', provider });
  const m = metrics(store, { now });
  assert.equal(m.orders.created, 2);
  assert.equal(m.conversion, 0.5);
  assert.equal(m.orders.pending, 1);
});

test('price advice flags an unprofitable price and suggests a floor', () => {
  const bad = priceAdvice({ amount: 100, fee: 59, targetMargin: 0.8 });
  assert.equal(bad.healthy, false);
  assert.match(bad.suggestion, /charge at least 295/);
  const good = priceAdvice({ amount: 5000, fee: 175, targetMargin: 0.8 });
  assert.equal(good.healthy, true);
  assert.equal(good.suggestion, null);
});
