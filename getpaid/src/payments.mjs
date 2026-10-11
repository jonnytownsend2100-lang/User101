/**
 * Payments: Stripe Checkout session creation + webhook signature verification.
 *
 * Two modes, chosen by environment, never by a code change:
 *   - **live**: `STRIPE_SECRET_KEY` is set → real API calls, real money.
 *   - **mock**: no key → deterministic fake links. The app is fully exercisable
 *     locally, and the mock mode is loud about itself in every response so it
 *     can never be mistaken for revenue.
 *
 * Signature verification is implemented from the documented scheme
 * (`t=<unix>,v1=<hex hmac-sha256 of "t.body">`) rather than pulled from a
 * dependency, because this is the single line of code standing between a
 * webhook endpoint and anyone on the internet marking invoices paid.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_API = 'https://api.stripe.com/v1';
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function stripeMode(env = process.env) {
  return env.STRIPE_SECRET_KEY ? 'live' : 'mock';
}

/**
 * Create a Stripe Checkout Session for the outstanding balance.
 * @returns {Promise<{mode:'live'|'mock', url:string, id:string}>}
 */
export async function createCheckoutSession(invoice, amountDueCents, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  successUrl = 'https://example.invalid/paid',
  cancelUrl = 'https://example.invalid/cancelled',
} = {}) {
  if (amountDueCents <= 0) throw new Error('nothing due on this invoice');
  if (stripeMode(env) === 'mock') {
    return {
      mode: 'mock',
      id: `mock_cs_${invoice.id}`,
      url: `https://pay.mock.local/${invoice.id}?amount=${amountDueCents}`,
    };
  }

  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  params.set('customer_email', invoice.customer.email);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', (invoice.currency ?? 'USD').toLowerCase());
  params.set('line_items[0][price_data][unit_amount]', String(amountDueCents));
  params.set('line_items[0][price_data][product_data][name]', `Invoice ${invoice.number}`);
  params.set('metadata[invoice_id]', invoice.id);
  params.set('payment_intent_data[metadata][invoice_id]', invoice.id);

  const res = await fetchImpl(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
    },
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`stripe checkout failed (${res.status}): ${text.slice(0, 500)}`);
  const session = JSON.parse(text);
  if (!session.url) throw new Error('stripe returned a session with no url');
  return { mode: 'live', id: session.id, url: session.url };
}

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 *
 * Rejects: missing/malformed headers, timestamps outside the tolerance window
 * (replay protection), and mismatched HMACs. Comparison is constant-time.
 *
 * @returns {{valid:boolean, reason:string, timestamp?:number}}
 */
export function verifyStripeSignature({
  header,
  payload,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowMs = Date.now(),
} = {}) {
  if (!secret) return { valid: false, reason: 'no_webhook_secret_configured' };
  if (!header || typeof header !== 'string') return { valid: false, reason: 'missing_signature_header' };

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=').map((s) => s?.trim());
    if (key === 't') timestamp = Number(value);
    if (key === 'v1') signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    return { valid: false, reason: 'malformed_signature_header' };
  }

  const ageSeconds = Math.abs(nowMs / 1000 - timestamp);
  if (ageSeconds > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_out_of_tolerance', timestamp };
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  for (const candidate of signatures) {
    const candidateBuf = Buffer.from(String(candidate), 'utf8');
    // timingSafeEqual throws on length mismatch, so compare lengths first
    // (length is not secret, so this leaks nothing).
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return { valid: true, reason: 'ok', timestamp };
    }
  }
  return { valid: false, reason: 'signature_mismatch', timestamp };
}

/**
 * Turn a verified Stripe event into ledger changes.
 *
 * Every branch is written to be safe to run twice: Stripe retries webhooks on
 * any non-2xx, and at-least-once delivery means duplicates are normal.
 *
 * @param {import('./store.mjs').Store} store
 * @param {any} event parsed Stripe event
 */
export function applyStripeEvent(store, event) {
  const type = event?.type;
  const object = event?.data?.object ?? {};
  const invoiceId = object.metadata?.invoice_id;

  if (type === 'checkout.session.completed') {
    if (!invoiceId) return { applied: false, reason: 'no_invoice_id_in_metadata' };
    if (object.payment_status && object.payment_status !== 'paid') {
      return { applied: false, reason: `payment_status=${object.payment_status}` };
    }
    const invoice = store.getInvoice(invoiceId);
    if (!invoice) return { applied: false, reason: 'unknown_invoice' };
    if (invoice.status !== 'open') return { applied: false, reason: `already_${invoice.status}` };

    const cents = typeof object.amount_total === 'number' ? object.amount_total : null;
    if (cents === null) return { applied: false, reason: 'no_amount_total' };
    if (cents > store.amountDueCents(invoice)) {
      // Overpayment is a real-world event (fees, late fee races). Record it and
      // flag it, never silently swallow it.
      store.recordPayment(invoice.id, cents, { method: 'stripe', reference: object.id ?? '' });
      store.addEvent('payment.overpaid', { invoiceId: invoice.id, cents, expected: store.amountDueCents(invoice) });
      return { applied: true, invoiceId: invoice.id, cents, warning: 'overpayment' };
    }
    store.recordPayment(invoice.id, cents, { method: 'stripe', reference: object.id ?? '' });
    return { applied: true, invoiceId: invoice.id, cents };
  }

  if (type === 'charge.refunded' && invoiceId) {
    store.addEvent('payment.refunded', { invoiceId, cents: object.amount_refunded ?? null });
    return { applied: true, invoiceId, refunded: true };
  }

  // Unhandled event types are acknowledged (2xx) so Stripe stops retrying.
  return { applied: false, reason: `unhandled_event_type:${type ?? 'unknown'}` };
}

