/**
 * Playbooks — how people actually make money, with honest numbers.
 *
 * Ranges are drawn from published surveys, platform data, and operator
 * accounts. They are wide on purpose: the spread *is* the finding. Every
 * "realisticMonthlyNetRange" is money in your pocket after the obvious costs,
 * not gross revenue, and it is what a competent, persistent operator reaches —
 * not the median new entrant, which for several of these is $0.
 *
 * `preset` seeds the calculator so a playbook can be stress-tested immediately.
 */

export const PLAYBOOKS = [
  {
    id: 'freelance',
    name: 'Freelance skill-for-hire',
    mode: 'flow',
    summary:
      'Trade a skill you already have for money, billed by the hour or the project. Fastest path to a first dollar; slowest to compound.',
    startupCostRange: [0, 500],
    monthsToFirstDollar: [0, 2],
    realisticMonthlyNetRange: [500, 6000],
    hoursPerWeek: [8, 20],
    difficulty: 2,
    keyRisk: 'Income stops the moment you stop working. Rates are capped by the hours in a day.',
    whyMostFail:
      'Most people price at commodity rates and never raise them, so the ceiling arrives quickly.',
    firstThreeSteps: [
      'Pick one specific service and one specific buyer you can already serve well.',
      'Set a rate you can defend, then deliver three paid pieces of work at that rate.',
      'Raise the rate 20% on each new client until you start losing deals — that is your price.',
    ],
    preset: { mode: 'flow', price: 800, units: 4, growthPct: 4, variableCostPct: 5, fixedCostMonthly: 150, acqCostPerUnit: 20, taxRatePct: 28, hoursPerWeek: 15 },
  },
  {
    id: 'productized-service',
    name: 'Productized service (retainer)',
    mode: 'recurring',
    summary:
      'A fixed scope, fixed price, monthly subscription service. Predictable revenue without building software.',
    startupCostRange: [0, 2000],
    monthsToFirstDollar: [1, 3],
    realisticMonthlyNetRange: [1000, 10000],
    hoursPerWeek: [15, 35],
    difficulty: 3,
    keyRisk: 'Delivery capacity is still your time. Churn decides whether it compounds.',
    whyMostFail: 'Scope creeps until each client is unprofitable, then the model collapses.',
    firstThreeSteps: [
      'Write the scope as a single sentence a client could repeat to a colleague.',
      'Deliver it manually for three clients before automating any part of it.',
      'Track churn monthly; if it exceeds 5%/mo, fix delivery before chasing growth.',
    ],
    preset: { mode: 'recurring', price: 900, units: 6, growthPct: 8, churnPct: 4, variableCostPct: 25, fixedCostMonthly: 600, acqCostPerUnit: 120, taxRatePct: 28, hoursPerWeek: 25 },
  },
  {
    id: 'micro-saas',
    name: 'Micro-SaaS',
    mode: 'recurring',
    summary:
      'A small software product with recurring subscriptions. The only category here that can compound without your time.',
    startupCostRange: [0, 5000],
    monthsToFirstDollar: [2, 9],
    realisticMonthlyNetRange: [0, 15000],
    hoursPerWeek: [10, 30],
    difficulty: 5,
    keyRisk: 'The distribution problem, not the build. Most products are never seen.',
    whyMostFail:
      'The large majority never reach $1k MRR, while a long tail of solo products does very well. The outcome is bimodal, not average.',
    firstThreeSteps: [
      'Sell to five people before you write code — a landing page and a conversation is enough.',
      'Charge from day one; free users teach you less than paying ones.',
      'Cap your build time. If nobody pays in 90 days, change the problem, not the buttons.',
    ],
    preset: { mode: 'recurring', price: 29, units: 40, growthPct: 12, churnPct: 6, variableCostPct: 15, fixedCostMonthly: 300, acqCostPerUnit: 35, taxRatePct: 28, hoursPerWeek: 15 },
  },
  {
    id: 'digital-products',
    name: 'Digital products',
    mode: 'flow',
    summary:
      'Courses, templates, presets, ebooks. Near-zero marginal cost and a cheap failure — but they need an audience to sell to.',
    startupCostRange: [0, 500],
    monthsToFirstDollar: [0, 3],
    realisticMonthlyNetRange: [0, 5000],
    hoursPerWeek: [5, 15],
    difficulty: 3,
    keyRisk: 'Without distribution, sales are approximately zero. The product is the easy half.',
    whyMostFail:
      'Builders publish to nobody. Revenue tracks audience size far more than product quality.',
    firstThreeSteps: [
      'Sell a $20 version of the thing before building the $200 version.',
      'Build the audience in parallel, not after — one channel, consistently.',
      'Raise the price with each round of feedback until conversion drops.',
    ],
    preset: { mode: 'flow', price: 45, units: 60, growthPct: 8, variableCostPct: 12, fixedCostMonthly: 120, acqCostPerUnit: 6, taxRatePct: 28, hoursPerWeek: 10 },
  },
  {
    id: 'local-service',
    name: 'Local service business',
    mode: 'flow',
    summary:
      'Mobile detailing, cleaning, lawn care, window washing. Unfashionable, dependable, and largely insulated from software-driven price pressure.',
    startupCostRange: [1000, 15000],
    monthsToFirstDollar: [0, 1],
    realisticMonthlyNetRange: [1500, 8000],
    hoursPerWeek: [10, 40],
    difficulty: 2,
    keyRisk: 'The ceiling is your body and your hours until you hire and train someone else.',
    whyMostFail:
      'No repeat scheduling, so every month starts from zero. Retention is the whole business.',
    firstThreeSteps: [
      'Buy the minimum equipment needed to serve the first paying customer.',
      'Go door-to-door or via local groups for the first ten customers — it beats early ad spend.',
      'Move every customer onto a recurring schedule from the first visit.',
    ],
    preset: { mode: 'flow', price: 150, units: 45, growthPct: 5, variableCostPct: 30, fixedCostMonthly: 900, acqCostPerUnit: 25, taxRatePct: 28, hoursPerWeek: 25 },
  },
  {
    id: 'ecommerce',
    name: 'Ecommerce (print-on-demand / dropship)',
    mode: 'flow',
    summary:
      'Sell a physical product you never physically hold. Trivial to start, brutal on margin and acquisition cost.',
    startupCostRange: [200, 3000],
    monthsToFirstDollar: [0, 2],
    realisticMonthlyNetRange: [0, 4000],
    hoursPerWeek: [10, 30],
    difficulty: 4,
    keyRisk: 'Ad costs rise faster than your price can. Most stores never clear positive contribution.',
    whyMostFail:
      'People buy traffic before proving that a single unit is profitable at any volume.',
    firstThreeSteps: [
      'Prove one product sells at all with a positive contribution margin before spending on ads.',
      'Compute your break-even CAC and stop spending the day you cross it.',
      'Cut delivery cost and lead time before scaling spend.',
    ],
    preset: { mode: 'flow', price: 42, units: 120, growthPct: 6, variableCostPct: 55, fixedCostMonthly: 300, acqCostPerUnit: 14, taxRatePct: 28, hoursPerWeek: 15 },
  },
  {
    id: 'coaching',
    name: 'Coaching / tutoring',
    mode: 'recurring',
    summary:
      'High hourly rate, low startup cost, tightly capped by your calendar. Excellent side income, poor scalability.',
    startupCostRange: [0, 1000],
    monthsToFirstDollar: [0, 2],
    realisticMonthlyNetRange: [800, 6000],
    hoursPerWeek: [6, 20],
    difficulty: 2,
    keyRisk: 'An absolute time ceiling. Growth means raising price, not adding clients.',
    whyMostFail:
      'Charging near-commodity rates and taking on too many clients, then burning out.',
    firstThreeSteps: [
      'Anchor on a single outcome you reliably produce for a specific kind of person.',
      'Raise the price every three clients, with no exceptions.',
      'Package the recurring part as a subscription to stabilise income.',
    ],
    preset: { mode: 'recurring', price: 300, units: 6, growthPct: 3, churnPct: 10, variableCostPct: 5, fixedCostMonthly: 100, acqCostPerUnit: 40, taxRatePct: 28, hoursPerWeek: 8 },
  },
  {
    id: 'audience',
    name: 'Audience → sponsorship',
    mode: 'recurring',
    summary:
      'A newsletter, channel, or community monetised by sponsors and paid subscriptions. Slowest to pay, strongest moat.',
    startupCostRange: [0, 500],
    monthsToFirstDollar: [3, 18],
    realisticMonthlyNetRange: [0, 8000],
    hoursPerWeek: [5, 20],
    difficulty: 4,
    keyRisk: 'Years of unpaid work before revenue, with no guarantee. Most never reach a sponsor threshold.',
    whyMostFail:
      'No consistent publishing cadence, so the audience never compounds past a few hundred readers.',
    firstThreeSteps: [
      'Publish on a fixed schedule for 12 weeks before judging anything.',
      'Grow one list you own (email) rather than one a platform rents to you.',
      'Approach sponsors only once the list size and open rate are worth quoting.',
    ],
    preset: { mode: 'recurring', price: 8, units: 250, growthPct: 9, churnPct: 4, variableCostPct: 3, fixedCostMonthly: 150, acqCostPerUnit: 2, taxRatePct: 28, hoursPerWeek: 12 },
  },
  {
    id: 'reselling',
    name: 'Reselling / arbitrage',
    mode: 'flow',
    summary:
      'Buy low, sell higher — used goods, wholesale lots, collectibles. Cash-positive quickly, with thin and competitive margins.',
    startupCostRange: [200, 5000],
    monthsToFirstDollar: [0, 1],
    realisticMonthlyNetRange: [200, 3000],
    hoursPerWeek: [8, 25],
    difficulty: 3,
    keyRisk: 'Dead stock. Working capital sits in inventory that may never sell.',
    whyMostFail:
      'Buying on gut feel and letting unsold inventory accumulate until the capital is exhausted.',
    firstThreeSteps: [
      'Sell ten items you already own to learn the real fees, shipping, and returns.',
      'Record realised margin per item, not per batch.',
      'Reinvest only in categories with three consecutive profitable months.',
    ],
    preset: { mode: 'flow', price: 55, units: 90, growthPct: 4, variableCostPct: 45, fixedCostMonthly: 200, acqCostPerUnit: 3, taxRatePct: 28, hoursPerWeek: 12 },
  },
];

export function playbookById(id) {
  return PLAYBOOKS.find((p) => p.id === id) ?? null;
}

