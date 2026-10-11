import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { metrics, priceAdvice } from './ledger.js';
import { CheckoutError, createOrder, markPaid, refund } from './checkout.js';
import { verifyLicense } from './license.js';
import { dashboard, errorPage, landing, mockPay, thanks } from './pages.js';
import { getProvider } from './providers.js';

const MAX_BODY = 64 * 1024;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const parseJson = (raw) => {
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
};

const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

/** Fixed-window rate limit. Crude, but it stops a single script draining the catalog. */
function rateLimiter({ windowMs = 60_000, max = 40 } = {}) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= max;
  };
}

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    ...headers,
  });
  res.end(payload);
};

export function createApp({
  store,
  providerName = 'mock',
  adminToken,
  licenseSecret,
  stripeWebhookSecret = null,
  stripeSecretKey = null,
  baseUrl = null,
  allowMock = true,
  days = 30,
  logger = console,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  if (!store) throw new Error('createApp requires a store');
  if (!licenseSecret) throw new Error('createApp requires licenseSecret');
  const provider = getProvider(providerName, { allowMock });
  const limited = rateLimiter();
  const secretKey = stripeSecretKey ?? process.env.STRIPE_SECRET_KEY ?? null;

  const isAdmin = (req, url) => {
    if (!adminToken) return false;
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    return safeEqual(bearer || url.searchParams.get('token') || '', adminToken);
  };

  const orderPublic = (order) => ({
    id: order.id,
    productName: order.productName,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    checkoutUrl: order.checkoutUrl,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
  });

  async function handle(req, res) {
    const url = new URL(req.url, baseUrl ?? `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';

    if (method === 'GET' && path === '/healthz') return send(res, 200, { ok: true, provider: provider.name });

    if (method === 'GET' && path === '/') {
      const notice = provider.live ? null : 'Running the mock provider: payments are simulated, no card is charged.';
      return send(res, 200, landing({ products: store.all('products').filter((p) => p.active !== false), provider: provider.name, notice }));
    }

    if (method === 'GET' && path === '/api/products') {
      return send(res, 200, {
        provider: provider.name,
        products: store.all('products').filter((p) => p.active !== false).map((p) => ({
          id: p.id, slug: p.slug, name: p.name, tagline: p.tagline, description: p.description,
          amount: p.amount, currency: p.currency, interval: p.interval,
          payWhatYouWant: p.payWhatYouWant, minimumAmount: p.minimumAmount,
        })),
      });
    }

    if (method === 'GET' && path.startsWith('/pay/')) {
      if (provider.name !== 'mock') return send(res, 404, errorPage(404, 'this deployment uses a live provider'));
      const order = store.find('orders', path.slice('/pay/'.length));
      if (!order) return send(res, 404, errorPage(404, 'unknown order'));
      if (order.status === 'paid') return send(res, 302, '', { location: `/thanks?order=${order.id}&t=${order.claimToken}` });
      return send(res, 200, mockPay({ order }));
    }

    if (method === 'GET' && path === '/thanks') {
      const order = store.find('orders', url.searchParams.get('order') ?? '');
      const token = url.searchParams.get('t') ?? '';
      // The claim token is what makes an order URL safe to hand to a buyer:
      // the order id alone must not be enough to read someone's license key.
      if (!order || !order.claimToken || !safeEqual(token, order.claimToken)) {
        return send(res, 403, errorPage(403, 'that order link is not valid'));
      }
      const license = store.findOne('licenses', (l) => l.orderId === order.id && l.status === 'active');
      return send(res, 200, thanks({ order, license, claimUrl: `${url.origin}/thanks?order=${order.id}&t=${token}` }));
    }

    if (method === 'GET' && path === '/dashboard') {
      if (!isAdmin(req, url)) return send(res, 401, errorPage(401, 'admin token required (?token=... or Authorization: Bearer ...)'));
      return send(res, 200, dashboard({ m: metrics(store, { now: now(), days }), provider: provider.name, days }));
    }

    if (method === 'GET' && path === '/api/metrics') {
      if (!isAdmin(req, url)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, metrics(store, { now: now(), days }));
    }

    if (method === 'GET' && path === '/api/orders') {
      if (!isAdmin(req, url)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { orders: store.all('orders').slice(-200).reverse().map(orderPublic) });
    }

    if (method === 'GET' && path.startsWith('/api/orders/')) {
      const order = store.find('orders', path.slice('/api/orders/'.length));
      const token = url.searchParams.get('t') ?? '';
      if (!order || !order.claimToken || !safeEqual(token, order.claimToken)) return send(res, 404, { error: 'not found' });
      const license = store.findOne('licenses', (l) => l.orderId === order.id && l.status === 'active');
      return send(res, 200, { order: orderPublic(order), license: license?.key ?? null });
    }

    if (method === 'POST' && path === '/api/checkout') {
      if (!limited(`checkout:${ip}`)) return send(res, 429, { error: 'too many requests' });
      const body = parseJson(await readBody(req));
      const order = await createOrder(store, {
        productId: body.productId,
        email: body.email,
        quantity: body.quantity ?? 1,
        amountMinor: body.amountMinor ?? null,
        provider,
        baseUrl: baseUrl ?? url.origin,
        secretKey,
        fetchImpl,
        now: now(),
      });
      const advice = priceAdvice({ amount: order.amount, fee: order.fee });
      return send(res, 201, {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        fee: order.fee,
        net: order.net,
        checkoutUrl: order.checkoutUrl,
        claimToken: order.claimToken,
        margin: advice.margin,
        warning: advice.suggestion,
      });
    }

    if (method === 'POST' && path === '/api/webhook/mock') {
      const raw = await readBody(req);
      const body = parseJson(raw);
      // The simulated buyer must prove it holds this order's claim token.
      // Without that check anyone could POST an order id and mint a free license.
      const target = store.find('orders', body?.orderId ?? '');
      if (!target || !target.claimToken || !safeEqual(body?.claimToken ?? '', target.claimToken)) {
        return send(res, 403, { error: 'mock settlement requires the order claim token' });
      }
      const event = await provider.parseWebhook({ body, rawBody: raw.toString('utf8'), header: req.headers['stripe-signature'], secret: stripeWebhookSecret });
      if (event.type === 'paid') {
        const { order, license, duplicate } = await markPaid(store, event.orderId, {
          providerRef: event.providerRef,
          amountMinor: event.amountMinor ?? null,
          licenseSecret,
          now: now(),
        });
        logger.log(`[mint] paid order=${order.id} amount=${order.amount} duplicate=${duplicate}`);
        return send(res, 200, { ok: true, duplicate, redirect: `/thanks?order=${order.id}&t=${order.claimToken}`, license: license?.key ?? null });
      }
      if (event.type === 'refunded') {
        const order = await refund(store, event.orderId, { now: now(), reason: 'provider webhook' });
        return send(res, 200, { ok: true, order: orderPublic(order) });
      }
      return send(res, 202, { ok: true, ignored: true });
    }

    if (method === 'POST' && path === '/api/webhook/stripe') {
      const raw = await readBody(req);
      const body = parseJson(raw);
      const event = await provider.parseWebhook({
        body,
        rawBody: raw.toString('utf8'),
        header: req.headers['stripe-signature'],
        secret: stripeWebhookSecret,
      });
      if (event.type === 'paid') {
        const { order, duplicate } = await markPaid(store, event.orderId, {
          providerRef: event.providerRef,
          amountMinor: event.amountMinor ?? null,
          licenseSecret,
          now: now(),
        });
        return send(res, 200, { received: true, duplicate, orderId: order.id });
      }
      if (event.type === 'refunded' && event.orderId) {
        await refund(store, event.orderId, { now: now(), reason: 'stripe charge.refunded' });
        return send(res, 200, { received: true, refunded: true });
      }
      return send(res, 200, { received: true, ignored: true });
    }

    if (method === 'POST' && path === '/api/verify') {
      if (!limited(`verify:${ip}`)) return send(res, 429, { error: 'too many requests' });
      const body = parseJson(await readBody(req));
      const result = verifyLicense(body.key, { secret: licenseSecret, now: now() });
      const stored = result.valid ? store.findOne('licenses', (l) => l.orderId === result.payload.sub) : null;
      const revoked = stored?.status === 'revoked';
      return send(res, result.valid && !revoked ? 200 : 402, {
        valid: result.valid && !revoked,
        reason: revoked ? 'revoked' : result.reason,
        claims: result.payload,
      });
    }

    if (method === 'POST' && path === '/api/refund') {
      if (!isAdmin(req, url)) return send(res, 401, { error: 'unauthorized' });
      const body = parseJson(await readBody(req));
      const order = await refund(store, body.orderId, { amountMinor: body.amountMinor ?? null, reason: body.reason ?? 'admin', now: now() });
      return send(res, 200, { ok: true, order: orderPublic(order) });
    }

    return send(res, 404, errorPage(404, `no route for ${method} ${path}`));
  }

  return http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      const status = err.status ?? (err instanceof CheckoutError ? err.status : 500);
      if (status >= 500) logger.error(`[mint] ${req.method} ${req.url} failed:`, err);
      if (res.headersSent) return res.end();
      const wantsJson = (req.url ?? '').startsWith('/api/');
      return wantsJson ? send(res, status, { error: err.message }) : send(res, status, errorPage(status, err.message));
    }
  });
}
