/**
 * The price list, as data.
 *
 * Nothing about pricing is hardcoded in the billing code: a price change is an
 * edit here, and `test/pricing.test.js` re-derives the invoice. The one thing
 * you cannot express as data is *policy*, so it lives in explicit flags:
 *
 *   hardCap: true   -> usage past `includedUnits` is REFUSED (402), never
 *                      billed. A free tier that can silently accrue overage is
 *                      a support queue, not a funnel.
 *   overageTiers    -> graduated bands over *overage* units (units beyond
 *                      `includedUnits`), not over total units.
 *
 * `unit` is the billable event. One unit = one task executed to a terminal
 * state. Failed tasks are not billed (see `lib/meter.js`).
 */

import { centsToMills, formatUsd, millsToCents } from './money.js';

/** @typedef {{id:string,name:string,blurb:string,priceCents:number,includedUnits:number,hardCap:boolean,overageTiers:Array<{upTo:number|null,millsPerUnit:number}>,rateLimitPerMinute:number,stripePriceIdEnv:string|null,features:string[]}} Plan */

/** @type {Record<string, Plan>} */
export const PLANS = {
  free: {
    id: 'free',
    unit: 'task',
    unitPlural: 'tasks',
    name: 'Free',
    blurb: 'Prove it works on your own data.',
    priceCents: 0,
    includedUnits: 100,
    hardCap: true,
    overageTiers: [],
    rateLimitPerMinute: 60,
    stripePriceIdEnv: null,
    features: [
      '100 tasks / month, hard-capped',
      'Durable queue with at-least-once delivery',
      'Task results retained for 7 days',
    ],
  },

  starter: {
    id: 'starter',
    unit: 'task',
    unitPlural: 'tasks',
    name: 'Starter',
    blurb: 'For one product, one team.',
    priceCents: 2900,
    includedUnits: 5_000,
    hardCap: false,
    // $6.00 per 1,000 overage tasks = 0.6 cents per task = 600 mills.
    overageTiers: [{ upTo: null, millsPerUnit: 600 }],
    rateLimitPerMinute: 600,
    stripePriceIdEnv: 'STRIPE_PRICE_STARTER',
    features: [
      '5,000 tasks / month included',
      'Overage billed at $6.00 per 1,000 tasks',
      'Results retained for 30 days',
      'Email support, 2 business days',
    ],
  },

  pro: {
    id: 'pro',
    unit: 'task',
    unitPlural: 'tasks',
    name: 'Pro',
    blurb: 'Volume, with a volume discount.',
    priceCents: 9900,
    includedUnits: 50_000,
    hardCap: false,
    // $4.00 / 1,000 = 400 mills per overage task for the first 200k, then 300.
    overageTiers: [
      { upTo: 200_000, millsPerUnit: 400 },
      { upTo: null, millsPerUnit: 300 },
    ],
    rateLimitPerMinute: 6_000,
    stripePriceIdEnv: 'STRIPE_PRICE_PRO',
    features: [
      '50,000 tasks / month included',
      'Overage: $4.00 per 1,000, dropping to $3.00 past 200,000',
      'Results retained for 90 days',
      'Priority queue + webhook retries',
    ],
  },
};

export const DEFAULT_PLAN_ID = 'free';

export function planIds() {
  return Object.keys(PLANS);
}

export function getPlan(id) {
  const plan = PLANS[id];
  if (!plan) {
    throw new RangeError(`unknown plan ${JSON.stringify(id)}; known plans: ${planIds().join(', ')}`);
  }
  return plan;
}

export function hasPlan(id) {
  return Object.prototype.hasOwnProperty.call(PLANS, id);
}

/**
 * What the *client* is allowed to see. Stripe price IDs are resolved from env
 * at call time so the same plan object works in test and in production, and the
 * landing page renders straight off this.
 */
export function publicPriceList(env = {}) {
  return planIds().map((id) => {
    const plan = PLANS[id];
    const overageLines = plan.overageTiers.map((tier, i) => {
      const previous = i === 0 ? 0 : plan.overageTiers[i - 1].upTo;
      const per = 1_000;
      const amount = formatUsd(millsToCents(tier.millsPerUnit * per));
      if (tier.upTo === null) {
        return i === 0
          ? `${amount} per 1,000 overage tasks`
          : `${amount} per 1,000 beyond ${previous.toLocaleString('en-US')}`;
      }
      return `${amount} per 1,000 up to ${tier.upTo.toLocaleString('en-US')}`;
    });

    return {
      id: plan.id,
      name: plan.name,
      blurb: plan.blurb,
      priceCents: plan.priceCents,
      price: formatUsd(plan.priceCents),
      includedUnits: plan.includedUnits,
      hardCap: plan.hardCap,
      overage: overageLines,
      rateLimitPerMinute: plan.rateLimitPerMinute,
      features: plan.features,
      stripePriceId: plan.stripePriceIdEnv ? env[plan.stripePriceIdEnv] ?? null : null,
    };
  });
}

/** Monthly subscription charge in mills. */
export function subscriptionMills(plan) {
  return centsToMills(getPlan(plan).priceCents);
}
