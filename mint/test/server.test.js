import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { seedCatalog } from '../lib/catalog.js';
import { createApp } from '../lib/server.js';

const adminToken = 'admin_test_token';
const licenseSecret = 'server-test-secret';

const silent = { log() {}, error() {} };

async function boot(overrides = {}) {
  const store = new Store();
  const products = seedCatalog(store);
  const app = createApp({ store, providerName: 'mock', adminToken, licenseSecret, logger: silent, ...overrides });
  await new Promise((resolve) => app.listen(0, resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  return { store, products, app, base, close: () => new Promise((r) => app.close(r)) };
}

const json = async (res) => ({ status: res.status, body: await res.json() });
const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function buy(ctx, slug, email = 'buyer@example.com', extra = {}) {
  const { body } = await json(await post(ctx.base, '/api/checkout', { productId: slug, email, ...extra }));
  return body;
}

async function settle(ctx, order, type = 'paid') {
  const orderId = typeof order === 'string' ? order : order.orderId;
  const claimToken = typeof order === 'string' ? undefined : order.claimToken;
  return json(await post(ctx.base, '/api/webhook/mock', { orderId, claimToken, type }));
}

test('health and storefront respond', async () => {
  const ctx = await boot();
  try {
    assert.equal((await json(await fetch(`${ctx.base}/healthz`))).body.ok, true);
    const home = await fetch(ctx.base);
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /Mint Pro/);
    assert.match(html, /simulated/i);
  } finally {
    await ctx.close();
  }
});

test('the catalog is public and never leaks internals', async () => {
  const ctx = await boot();
  try {
    const { body } = await json(await fetch(`${ctx.base}/api/products`));
    assert.equal(body.products.length, 3);
    assert.equal(body.products[0].slug, 'mint-pro');
    assert.equal(body.products[0].amount, 2900);
    assert.equal(body.products[0].license, undefined);
  } finally {
    await ctx.close();
  }
});

test('a full sale: checkout -> simulated pay -> license on the claim page', async () => {
  const ctx = await boot();
  try {
    const order = await buy(ctx, 'mint-pro');
    assert.equal(order.amount, 2900);
    assert.equal(order.fee, 0, 'mock provider charges nothing');
    assert.match(order.checkoutUrl, /\/pay\/ord_/);

    const payPage = await fetch(order.checkoutUrl);
    assert.equal(payPage.status, 200);
    assert.match(await payPage.text(), /Simulated checkout/);

    const settled = await settle(ctx, order);
    assert.equal(settled.body.ok, true);
    const redirect = settled.body.redirect;
    assert.match(redirect, /^\/thanks\?order=ord_[0-9a-f]+&t=tok_[0-9a-f]+$/);

    const thanks = await fetch(`${ctx.base}${redirect}`);
    const html = await thanks.text();
    assert.equal(thanks.status, 200);
    assert.match(html, /MINT\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);

    // The order URL without its claim token must not disclose the license.
    const leaked = await fetch(`${ctx.base}/thanks?order=${order.orderId}`);
    assert.equal(leaked.status, 403);
    assert.equal((await json(await fetch(`${ctx.base}/api/orders/${order.orderId}`))).status, 404);
  } finally {
    await ctx.close();
  }
});

test('a paid order is idempotent under webhook retries', async () => {
  const ctx = await boot();
  try {
    const order = await buy(ctx, 'mint-lifetime');
    await settle(ctx, order);
    const again = await settle(ctx, order);
    assert.equal(again.body.duplicate, true);
    assert.equal(ctx.store.all('licenses').length, 1);
  } finally {
    await ctx.close();
  }
});

test('a mock settlement without the claim token is refused', async () => {
  const ctx = await boot();
  try {
    const order = await buy(ctx, 'mint-pro');
    const bare = await json(await post(ctx.base, '/api/webhook/mock', { orderId: order.orderId }));
    assert.equal(bare.status, 403);
    const wrong = await json(await post(ctx.base, '/api/webhook/mock', { orderId: order.orderId, claimToken: 'tok_deadbeefdead' }));
    assert.equal(wrong.status, 403);
    assert.equal(ctx.store.find('orders', order.orderId).status, 'pending');
    assert.equal(ctx.store.all('licenses').length, 0);
  } finally {
    await ctx.close();
  }
});

test('settling an unknown order is refused without disclosing whether it exists', async () => {
  const ctx = await boot();
  try {
    const res = await settle(ctx, 'ord_missing');
    assert.equal(res.status, 403);
    assert.match(res.body.error, /claim token/);
  } finally {
    await ctx.close();
  }
});

test('the console requires the admin token', async () => {
  const ctx = await boot();
  try {
    assert.equal((await fetch(`${ctx.base}/dashboard`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/metrics`)).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/metrics?token=wrong`)).status, 401);

    const dash = await fetch(`${ctx.base}/dashboard?token=${adminToken}`);
    assert.equal(dash.status, 200);
    assert.match(await dash.text(), /Owner console/);

    const m = await json(await fetch(`${ctx.base}/api/metrics`, { headers: { authorization: `Bearer ${adminToken}` } }));
    assert.equal(m.status, 200);
    assert.equal(m.body.net, 0);
  } finally {
    await ctx.close();
  }
});

test('metrics report net after fees for a real sale', async () => {
  const ctx = await boot({ providerName: 'stripe' });
  try {
    const store = ctx.store;
    // Seed a paid order through the same path the webhook uses.
    const { markPaid } = await import('../lib/checkout.js');
    const { createOrder } = await import('../lib/checkout.js');
    const { stripe } = await import('../lib/providers.js');
    const order = await createOrder(store, {
      productId: 'mint-pro',
      email: 'buyer@example.com',
      provider: stripe,
      baseUrl: ctx.base,
      secretKey: 'sk_test',
      fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }) }),
    });
    await markPaid(store, order.id, { licenseSecret, amountMinor: order.amount });
    const { body } = await json(await fetch(`${ctx.base}/api/metrics?token=${adminToken}`));
    assert.equal(body.gross, 2900);
    assert.equal(body.fees, 114);
    assert.equal(body.net, 2786);
    assert.equal(body.mrr, 2900);
  } finally {
    await ctx.close();
  }
});

test('license verification works and reflects revocation', async () => {
  const ctx = await boot();
  try {
    const order = await buy(ctx, 'mint-pro');
    const settled = await settle(ctx, order);
    const key = settled.body.license;

    const ok = await json(await post(ctx.base, '/api/verify', { key }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.valid, true);
    assert.equal(ok.body.claims.prd, ctx.store.all('products')[0].id);

    const refunded = await json(await post(ctx.base, `/api/refund?token=${adminToken}`, { orderId: order.orderId, reason: 'test' }));
    assert.equal(refunded.body.ok, true);

    const after = await json(await post(ctx.base, '/api/verify', { key }));
    assert.equal(after.status, 402);
    assert.equal(after.body.valid, false);
    assert.equal(after.body.reason, 'revoked');
  } finally {
    await ctx.close();
  }
});

test('refunds are admin-only', async () => {
  const ctx = await boot();
  try {
    const order = await buy(ctx, 'mint-pro');
    await settle(ctx, order);
    assert.equal((await post(ctx.base, '/api/refund', { orderId: order.orderId })).status, 401);
  } finally {
    await ctx.close();
  }
});

test('bad input produces 4xx with a useful message', async () => {
  const ctx = await boot();
  try {
    const badEmail = await json(await post(ctx.base, '/api/checkout', { productId: 'mint-pro', email: 'nope' }));
    assert.equal(badEmail.status, 400);
    assert.match(badEmail.body.error, /valid customer email/);

    const unknown = await json(await post(ctx.base, '/api/checkout', { productId: 'ghost', email: 'a@b.co' }));
    assert.equal(unknown.status, 404);

    const badJson = await fetch(`${ctx.base}/api/checkout`, { method: 'POST', body: '{oops' });
    assert.equal(badJson.status, 400);

    assert.equal((await fetch(`${ctx.base}/nope`)).status, 404);
  } finally {
    await ctx.close();
  }
});

test('the rate limiter stops a script from hammering checkout', async () => {
  const ctx = await boot();
  try {
    let limited = 0;
    for (let i = 0; i < 45; i += 1) {
      const res = await post(ctx.base, '/api/checkout', { productId: 'mint-pro', email: `a${i}@b.co` });
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0, 'expected the limiter to engage');
    assert.ok(limited <= 10, 'expected the limiter to engage only after the window fills');
  } finally {
    await ctx.close();
  }
});

test('pay-what-you-want is enforced at the edge too', async () => {
  const ctx = await boot();
  try {
    const cheap = await json(await post(ctx.base, '/api/checkout', { productId: 'consulting-hour', email: 'a@b.co', amountMinor: 1 }));
    assert.equal(cheap.status, 400);
    assert.match(cheap.body.error, /amount must be an integer/);
    const ok = await json(await post(ctx.base, '/api/checkout', { productId: 'consulting-hour', email: 'a@b.co', amountMinor: 20000 }));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.amount, 20000);
  } finally {
    await ctx.close();
  }
});
