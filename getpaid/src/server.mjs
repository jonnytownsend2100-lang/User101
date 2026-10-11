/**
 * HTTP surface: dashboard, JSON API, dunning cron endpoint, Stripe webhook.
 *
 * Auth posture (this app moves money, so the default is deny):
 *  - If `ADMIN_TOKEN` is set, every mutating route requires it as a bearer token.
 *  - If it is *not* set, mutating routes are allowed **only from loopback**, so
 *    local development works with zero setup and a deployed instance cannot be
 *    driven by a stranger. The response says so out loud.
 *  - The dunning endpoint additionally accepts `CRON_SECRET`, matching what
 *    Vercel Cron can send.
 *  - The webhook is verified by HMAC signature whenever
 *    `STRIPE_WEBHOOK_SECRET` exists. Without it, unsigned events are accepted
 *    only from loopback AND only with `ALLOW_UNSIGNED_WEBHOOKS=1`.
 */
import { createServer as httpCreateServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { openStore } from './store.mjs';
import { runDunning } from './dunning.mjs';
import { createCheckoutSession, verifyStripeSignature, applyStripeEvent, stripeMode } from './payments.mjs';
import { createMailer } from './mailer.mjs';
import { PLANS, createSubscriptionCheckout, getPlan } from './billing.mjs';
import { buildReport } from './report.mjs';
import { dashboardHtml, pricingHtml } from './views.mjs';

const MAX_BODY_BYTES = 256 * 1024;

/** Constant-time string compare that tolerates unequal lengths. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** @returns {{ok:boolean, reason:string, mode:string}} */
export function authorize(req, env = process.env, { secret = env.ADMIN_TOKEN } = {}) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-admin-token'] ?? '');
  if (secret) {
    return safeEqual(token, secret)
      ? { ok: true, reason: 'token', mode: 'token' }
      : { ok: false, reason: 'invalid_admin_token', mode: 'token' };
  }
  return isLoopback(req)
    ? { ok: true, reason: 'loopback_dev_mode', mode: 'dev' }
    : { ok: false, reason: 'admin_token_not_configured', mode: 'dev' };
}

export function readRawBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createServer({ store, mailer, env = process.env, now = () => new Date(), linkFactory } = {}) {
  if (!store) throw new Error('createServer requires a store');
  const ctx = { store, mailer, env, now, linkFactory };
  return httpCreateServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      // A malformed request is the client's fault (400); anything else is ours.
      const status = err.statusCode ?? (err instanceof TypeError || err instanceof SyntaxError ? 400 : 500);
      json(res, status, { error: String(err.message ?? err) });
    });
  });
}

async function handle(req, res, ctx) {
  const { store } = ctx;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  // ---- reads --------------------------------------------------------------

  if (method === 'GET' && (path === '/' || path === '/dashboard')) {
    const report = buildReport(store, { now: ctx.now() });
    return html(res, 200, dashboardHtml(report, store.listInvoices(), ctx.env));
  }

  if (method === 'GET' && path === '/pricing') {
    return html(res, 200, pricingHtml(PLANS, ctx.env));
  }

  if (method === 'GET' && path === '/healthz') {
    return json(res, 200, { ok: true, paymentMode: stripeMode(ctx.env), mailMode: ctx.mailer?.mode ?? 'none' });
  }

  if (method === 'GET' && path === '/api/plans') {
    return json(res, 200, { plans: PLANS });
  }

  if (method === 'GET' && path === '/api/report') {
    return json(res, 200, buildReport(store, { now: ctx.now() }));
  }

  if (method === 'GET' && path === '/api/invoices') {
    const status = url.searchParams.get('status') ?? undefined;
    const invoices = store.listInvoices(status ? { status } : {}).map((i) => ({
      ...i,
      amountDueCents: store.amountDueCents(i),
      daysOverdue: store.daysOverdue(i, ctx.now()),
    }));
    return json(res, 200, { invoices });
  }

  // ---- the webhook (unauthenticated by design; verified by signature) ------

  if (method === 'POST' && path === '/api/webhooks/stripe') {
    const raw = await readRawBody(req);
    const secret = ctx.env.STRIPE_WEBHOOK_SECRET;
    const header = req.headers['stripe-signature'];
    let verified;
    if (secret) {
      verified = verifyStripeSignature({ header, payload: raw, secret, nowMs: ctx.now().getTime() });
    } else if (ctx.env.ALLOW_UNSIGNED_WEBHOOKS === '1' && isLoopback(req)) {
      verified = { valid: true, reason: 'unsigned_dev_mode' };
    } else {
      verified = { valid: false, reason: 'no_webhook_secret_configured' };
    }
    if (!verified.valid) return json(res, 400, { error: 'signature_verification_failed', reason: verified.reason });

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: 'invalid_json' });
    }
    const result = applyStripeEvent(store, event);
    store.save();
    return json(res, 200, { received: true, verifiedBy: verified.reason, ...result });
  }

  // ---- mutations (authenticated) ------------------------------------------

  const auth = authorize(req, ctx.env);
  if (!auth.ok) return json(res, 403, { error: 'forbidden', reason: auth.reason });

  if (method === 'POST' && path === '/api/invoices') {
    const body = JSON.parse((await readRawBody(req)) || '{}');
    const invoice = store.addInvoice({
      number: body.number,
      customer: { name: body.customer?.name ?? body.name, email: body.customer?.email ?? body.email },
      amountCents: body.amountCents,
      currency: body.currency,
      dueAt: body.dueAt,
      notes: body.notes,
    });
    store.save();
    return json(res, 201, { invoice: { ...invoice, amountDueCents: store.amountDueCents(invoice) } });
  }

  const payMatch = path.match(/^\/api\/invoices\/([^/]+)\/pay$/);
  if (method === 'POST' && payMatch) {
    const invoice = store.getInvoice(decodeURIComponent(payMatch[1]));
    if (!invoice) return json(res, 404, { error: 'no_such_invoice' });
    const due = store.amountDueCents(invoice);
    if (due === 0) return json(res, 409, { error: 'nothing_due', status: invoice.status });
    const session = await createCheckoutSession(invoice, due, { env: ctx.env });
    invoice.checkout = { ...session, amountCents: due, at: ctx.now().toISOString() };
    store.addEvent('checkout.created', { invoiceId: invoice.id, mode: session.mode, amountCents: due });
    store.save();
    return json(res, 201, {
      paymentLink: session.url,
      mode: session.mode,
      amountCents: due,
      warning: session.mode === 'mock' ? 'mock_mode_no_money_moves' : undefined,
    });
  }

  const paidMatch = path.match(/^\/api\/invoices\/([^/]+)\/paid$/);
  if (method === 'POST' && paidMatch) {
    const invoice = store.getInvoice(decodeURIComponent(paidMatch[1]));
    if (!invoice) return json(res, 404, { error: 'no_such_invoice' });
    const settled = store.markPaid(invoice.id, { method: 'manual', reference: `admin:${auth.mode}` });
    store.save();
    return json(res, 200, { invoiceId: invoice.id, settled, recoveredCents: store.data.payments.at(-1).cents });
  }

  if (method === 'POST' && path === '/api/dunning/run') {
    const cronSecret = ctx.env.CRON_SECRET;
    if (cronSecret) {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!safeEqual(token, cronSecret)) return json(res, 403, { error: 'invalid_cron_secret' });
    }
    const body = JSON.parse((await readRawBody(req)) || '{}');
    const summary = await runDunning(store, {
      now: ctx.now(),
      dryRun: body.dryRun === true,
      send: ctx.mailer ? (msg) => ctx.mailer.send(msg) : null,
      linkFactory: ctx.linkFactory ?? ((invoice) =>
        createCheckoutSession(invoice, store.amountDueCents(invoice), { env: ctx.env }).then((s) => s.url)),
    });
    return json(res, 200, summary);
  }

  if (method === 'POST' && path === '/api/subscribe') {
    const raw = await readRawBody(req);
    const contentType = req.headers['content-type'] ?? '';
    const body = contentType.includes('application/json')
      ? JSON.parse(raw || '{}')
      : Object.fromEntries(new URLSearchParams(raw));
    const planId = body.planId ?? 'growth';
    const interval = body.interval === 'year' ? 'year' : 'month';
    if (!PLANS.some((p) => p.id === planId)) return json(res, 400, { error: 'unknown_plan', planId });
    const checkout = await createSubscriptionCheckout(planId, {
      env: ctx.env,
      interval,
      customerEmail: body.email ?? '',
    });
    // A started checkout is an intent, not revenue: MRR only moves when the
    // webhook confirms payment.
    store.addEvent('subscription.checkout_started', { planId, interval, mode: checkout.mode });
    store.save();
    if (contentType.includes('application/json')) return json(res, 201, checkout);
    res.writeHead(303, { location: checkout.url });
    return res.end();
  }

  return json(res, 404, { error: 'not_found', path, method });
}

/** Boot a server on a port; resolves once it is listening. */
export function startServer({ port = 0, host = '127.0.0.1', ...opts } = {}) {
  const server = createServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://${host}:${actual}` });
    });
  });
}

