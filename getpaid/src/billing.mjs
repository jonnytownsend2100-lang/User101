/**
 * The app's own revenue model: it is a subscription product, priced per month.
 *
 * This module exists so the business half of the product is code, not a
 * spreadsheet: plans, the checkout that starts a subscription, and the MRR
 * arithmetic that tells you whether the thing is working.
 */
import { STRIPE_API } from './payments.mjs';

/** Price list. Change prices here and every surface (page, API, MRR) follows. */
export const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    monthlyCents: 2900,
    annualCents: 29000, // 10 months for 12: the standard nudge toward annual
    blurb: 'Up to 50 open invoices. 1 seat.',
  },
  {
    id: 'growth',
    name: 'Growth',
    monthlyCents: 9900,
    annualCents: 99000,
    blurb: 'Unlimited invoices, 5 seats, custom dunning ladder.',
  },
  {
    id: 'scale',
    name: 'Scale',
    monthlyCents: 29900,
    annualCents: 299000,
    blurb: 'Collections handoff, API access, SLA.',
  },
];

export function getPlan(planId) {
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) throw new Error(`unknown plan: ${planId}`);
  return plan;
}

/** Price of one plan for one interval, in cents. */
export function priceCents(planId, interval = 'month') {
  const plan = getPlan(planId);
  if (interval === 'month') return plan.monthlyCents;
  if (interval === 'year') return plan.annualCents;
  throw new Error(`unknown interval: ${interval}`);
}

/**
 * Normalise a subscription to a monthly figure. Annual plans are divided by 12
 * so MRR stays comparable across the book.
 */
export function monthlyEquivalentCents(sub, plans = PLANS) {
  const plan = plans.find((p) => p.id === sub.planId);
  if (!plan) return 0;
  if (sub.interval === 'year') return Math.round(plan.annualCents / 12);
  return plan.monthlyCents;
}

/**
 * Monthly recurring revenue over the active book.
 * Canceled and non-active subscriptions are excluded — MRR you cannot bill is
 * not revenue, it is a vanity number.
 */
export function mrrCents(store, { plans = PLANS } = {}) {
  return store
    .listSubscriptions()
    .filter((s) => s.status === 'active')
    .reduce((total, sub) => total + monthlyEquivalentCents(sub, plans), 0);
}

export const arrCents = (store, opts) => mrrCents(store, opts) * 12;

/**
 * Create the checkout that starts a subscription (i.e. that earns the app money).
 * Same mock/live split as invoice payments.
 */
export async function createSubscriptionCheckout(planId, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  interval = 'month',
  customerEmail = '',
  successUrl = 'https://example.invalid/welcome',
  cancelUrl = 'https://example.invalid/pricing',
} = {}) {
  const plan = getPlan(planId);
  const cents = priceCents(planId, interval);

  if (!env.STRIPE_SECRET_KEY) {
    return {
      mode: 'mock',
      id: `mock_sub_${planId}_${interval}`,
      planId,
      interval,
      amountCents: cents,
      url: `https://pay.mock.local/subscribe/${planId}/${interval}?amount=${cents}`,
    };
  }

  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  if (customerEmail) params.set('customer_email', customerEmail);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', 'usd');
  params.set('line_items[0][price_data][unit_amount]', String(cents));
  params.set('line_items[0][price_data][product_data][name]', `GetPaid ${plan.name}`);
  params.set('line_items[0][price_data][recurring][interval]', interval);
  params.set('metadata[plan_id]', planId);

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
  if (!res.ok) throw new Error(`stripe subscription checkout failed (${res.status}): ${text.slice(0, 400)}`);
  const session = JSON.parse(text);
  return { mode: 'live', id: session.id, url: session.url, planId, interval, amountCents: cents };
}
