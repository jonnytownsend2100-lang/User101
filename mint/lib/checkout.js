import { issueLicense } from './license.js';
import { providerFee } from './money.js';
import { id } from './store.js';

// The order lifecycle. Every transition that moves money writes an event, so
// the ledger is reconstructable from the audit trail alone.
//
//   pending --(webhook: paid)--> paid --(refund)--> refunded

export class CheckoutError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CheckoutError';
    this.status = status;
  }
}

export function upsertCustomer(store, email) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) throw new CheckoutError('a valid customer email is required');
  const existing = store.findOne('customers', (c) => c.email === normalized);
  if (existing) return existing;
  const customer = store.insert('customers', {
    email: normalized,
    createdAt: new Date().toISOString(),
    orders: 0,
    lifetimeValue: 0,
  });
  store.log('customer.created', { customerId: customer.id, email: normalized });
  return customer;
}

export function findProduct(store, productId) {
  const product = store.find('products', productId) ?? store.findOne('products', (p) => p.slug === productId);
  if (!product) throw new CheckoutError(`no such product: ${productId}`, 404);
  if (product.active === false) throw new CheckoutError(`product is not for sale: ${product.name}`, 409);
  return product;
}

/**
 * Create a pending order and a provider checkout session for it.
 * `payWhatYouWant` products accept a `quantity`/`amount` override, floored at
 * the product minimum -- an unfloored override is how you accidentally sell a
 * $49 product for $0.01.
 */
export async function createOrder(store, {
  productId,
  email,
  quantity = 1,
  amountMinor = null,
  provider,
  baseUrl = 'http://localhost:8787',
  secretKey = null,
  fetchImpl = fetch,
  now = new Date(),
}) {
  const product = findProduct(store, productId);
  const customer = upsertCustomer(store, email);
  const qty = Math.max(1, Math.min(Number(quantity) || 1, product.maxQuantity ?? 100));

  let amount = product.amount * qty;
  if (product.payWhatYouWant) {
    const floor = product.minimumAmount ?? product.amount;
    if (amountMinor == null) throw new CheckoutError('this product requires an amount');
    if (!Number.isInteger(amountMinor) || amountMinor < floor) {
      throw new CheckoutError(`amount must be an integer >= ${floor}`);
    }
    amount = amountMinor;
  } else if (amountMinor != null && amountMinor !== amount) {
    throw new CheckoutError('this product has a fixed price');
  }

  const fee = providerFee(amount, provider.fee);
  const order = store.insert('orders', {
    id: id('ord'),
    productId: product.id,
    productName: product.name,
    customerId: customer.id,
    email: customer.email,
    quantity: qty,
    amount,
    currency: product.currency ?? 'usd',
    fee,
    net: amount - fee,
    interval: product.interval ?? null,
    // The claim token, not the order id, is what authorises reading the order
    // back (and with it the license key). Order ids leak into logs and URLs.
    claimToken: id('tok'),
    status: 'pending',
    provider: provider.name,
    providerRef: null,
    checkoutUrl: null,
    createdAt: now.toISOString(),
    paidAt: null,
    refundedAt: null,
  });
  store.log('order.created', { orderId: order.id, productId: product.id, amount, fee });

  try {
    const session = await provider.createCheckout({ order, product, baseUrl, secretKey, fetchImpl });
    store.update('orders', order.id, session);
    store.log('checkout.session_created', { orderId: order.id, providerRef: session.providerRef });
  } catch (err) {
    store.update('orders', order.id, { status: 'failed', failure: err.message });
    store.log('checkout.failed', { orderId: order.id, error: err.message });
    throw err;
  }

  await store.save();
  return store.find('orders', order.id);
}

/**
 * Settle an order. Idempotent by construction: providers retry webhooks, and a
 * retried delivery must not mint a second license or double-count revenue.
 */
export async function markPaid(store, orderId, { providerRef = null, amountMinor = null, now = new Date(), licenseSecret, licenseDays = null } = {}) {
  const order = store.find('orders', orderId);
  if (!order) throw new CheckoutError(`no such order: ${orderId}`, 404);

  if (order.status === 'paid' || order.status === 'refunded') {
    store.log('order.duplicate_webhook', { orderId, status: order.status });
    await store.save();
    return { order, license: store.findOne('licenses', (l) => l.orderId === order.id), duplicate: true };
  }
  if (amountMinor != null && amountMinor !== order.amount) {
    // Underpayment is refused, not silently accepted.
    if (amountMinor < order.amount) {
      throw new CheckoutError(`underpaid: expected ${order.amount}, got ${amountMinor}`, 409);
    }
    store.update('orders', order.id, { amount: amountMinor, net: amountMinor - order.fee });
    store.log('order.amount_adjusted', { orderId, from: order.amount, to: amountMinor });
  }

  store.update('orders', order.id, {
    status: 'paid',
    paidAt: now.toISOString(),
    providerRef: providerRef ?? order.providerRef,
  });
  store.log('order.paid', { orderId: order.id, amount: order.amount, fee: order.fee, net: order.amount - order.fee });

  const customer = store.find('customers', order.customerId);
  if (customer) {
    store.update('customers', customer.id, {
      orders: customer.orders + 1,
      lifetimeValue: customer.lifetimeValue + order.amount,
    });
  }

  let license = null;
  if (order.productId && store.find('products', order.productId)?.license !== false) {
    const product = store.find('products', order.productId);
    license = store.insert('licenses', {
      id: id('lic'),
      orderId: order.id,
      productId: order.productId,
      customerId: order.customerId,
      key: issueLicense({
        productId: order.productId,
        orderId: order.id,
        customerId: order.customerId,
        email: order.email,
        seats: product?.seats ?? 1,
        days: product?.licenseDays ?? licenseDays,
        secret: licenseSecret,
        now,
      }),
      status: 'active',
      issuedAt: now.toISOString(),
      revokedAt: null,
    });
    store.log('license.issued', { licenseId: license.id, orderId: order.id });
  }

  await store.save();
  return { order: store.find('orders', order.id), license, duplicate: false };
}

export async function refund(store, orderId, { amountMinor = null, now = new Date(), reason = 'requested' } = {}) {
  const order = store.find('orders', orderId);
  if (!order) throw new CheckoutError(`no such order: ${orderId}`, 404);
  if (order.status !== 'paid') throw new CheckoutError(`only paid orders can be refunded (order is ${order.status})`, 409);

  const amount = amountMinor ?? order.amount;
  if (amount > order.amount) throw new CheckoutError('refund exceeds the order amount');

  store.update('orders', order.id, {
    status: amount === order.amount ? 'refunded' : 'partially_refunded',
    refundedAt: now.toISOString(),
    refundedAmount: amount,
    refundReason: reason,
  });
  store.log('order.refunded', { orderId: order.id, amount, reason });

  const customer = store.find('customers', order.customerId);
  if (customer) store.update('customers', customer.id, { lifetimeValue: Math.max(0, customer.lifetimeValue - amount) });

  // A refunded license must stop working, or the refund is a donation.
  const license = store.findOne('licenses', (l) => l.orderId === order.id && l.status === 'active');
  if (license) {
    store.update('licenses', license.id, { status: 'revoked', revokedAt: now.toISOString() });
    store.log('license.revoked', { licenseId: license.id, orderId: order.id });
  }

  await store.save();
  return store.find('orders', order.id);
}
