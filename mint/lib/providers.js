import { createHmac, timingSafeEqual } from 'node:crypto';

// A payment provider is reduced to the only three things this app needs:
//   1. start a checkout   -> a URL to send the buyer to
//   2. translate a webhook -> a normalised { type, orderId, ... }
//   3. declare its fee schedule -> so the ledger can report net, not gross
//
// Two are shipped. `mock` is a real, clickable funnel that never touches the
// network, so the whole app is demonstrable offline. `stripe` is the live one.

export const STRIPE_DEFAULT_FEE = { bps: 290, fixed: 30 }; // 2.9% + $0.30 (US card, as published)

export const mock = {
  name: 'mock',
  live: false,
  fee: { bps: 0, fixed: 0 },
  checkoutPath: '/pay',

  async createCheckout({ order, baseUrl }) {
    return {
      providerRef: `mock_cs_${order.id}`,
      checkoutUrl: `${baseUrl}/pay/${order.id}`,
    };
  },

  // The simulated buyer posts { orderId } back. No signature: there is no
  // secret to protect because no money moves. Documented, not hidden.
  async parseWebhook({ body }) {
    const orderId = body?.orderId ?? body?.data?.orderId;
    if (!orderId) throw new Error('mock webhook requires orderId');
    return { type: body.type === 'refunded' ? 'refunded' : 'paid', orderId, providerRef: `mock_cs_${orderId}` };
  },
};

export const stripe = {
  name: 'stripe',
  live: true,
  fee: STRIPE_DEFAULT_FEE,

  async createCheckout({ order, product, baseUrl, secretKey, fetchImpl = fetch }) {
    if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required for the stripe provider');
    const form = new URLSearchParams({
      mode: product.interval ? 'subscription' : 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': order.currency,
      'line_items[0][price_data][unit_amount]': String(order.amount),
      'line_items[0][price_data][product_data][name]': product.name,
      success_url: `${baseUrl}/thanks?order=${order.id}`,
      cancel_url: `${baseUrl}/?canceled=${order.id}`,
      client_reference_id: order.id,
      customer_email: order.email,
    });
    if (product.interval) {
      form.set('line_items[0][price_data][recurring][interval]', product.interval);
    }

    const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe error: ${json?.error?.message ?? res.status}`);
    return { providerRef: json.id, checkoutUrl: json.url };
  },

  /** Verify a Stripe-Signature header over the RAW body. Throws on failure. */
  verifySignature({ rawBody, header, secret, toleranceSec = 300, now = Date.now() }) {
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is required to verify webhooks');
    const parts = Object.fromEntries(
      String(header ?? '')
        .split(',')
        .map((p) => p.split('=').map((s) => s.trim()))
        .filter((p) => p.length === 2),
    );
    const timestamp = Number(parts.t);
    if (!timestamp || !parts.v1) throw new Error('malformed stripe signature header');
    if (Math.abs(now / 1000 - timestamp) > toleranceSec) throw new Error('stripe signature outside tolerance');

    const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    const provided = Buffer.from(parts.v1, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (provided.length !== expectedBuf.length || !timingSafeEqual(provided, expectedBuf)) {
      throw new Error('stripe signature mismatch');
    }
    return true;
  },

  async parseWebhook({ body, rawBody, header, secret }) {
    this.verifySignature({ rawBody, header, secret });
    const event = body;
    const object = event?.data?.object ?? {};
    switch (event?.type) {
      case 'checkout.session.completed':
        return {
          type: 'paid',
          orderId: object.client_reference_id,
          providerRef: object.id,
          amountMinor: object.amount_total ?? null,
        };
      case 'charge.refunded':
        return {
          type: 'refunded',
          orderId: object.client_reference_id ?? object.metadata?.order_id ?? null,
          providerRef: object.id,
          amountMinor: object.amount_refunded ?? null,
        };
      default:
        return { type: 'ignored', providerRef: object.id ?? null };
    }
  },
};

export function getProvider(name, { allowMock = true } = {}) {
  if (name === 'stripe') return stripe;
  if (name === 'mock') {
    if (!allowMock) throw new Error('mock provider disabled (set MINT_ALLOW_MOCK=1 to enable)');
    return mock;
  }
  throw new Error(`unknown provider: ${name}`);
}
