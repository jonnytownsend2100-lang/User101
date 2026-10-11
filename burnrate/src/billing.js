// Turn raw GitHub Actions jobs into dollars.
//
// The only two inputs are (a) how long the job ran and (b) which runner it ran
// on. GitHub's own rule for (a) is documented and is implemented in
// jobBillableMinutes() below -- a job is never billed for less than one minute,
// and partial minutes round up.

import { resolveRunner, OS_MINUTE_MULTIPLIER, PLAN_ALLOWANCES } from './rates.js';

/**
 * Billable minutes for one job.
 * GitHub: "rounds the minutes and partial minutes each job uses up to the
 * nearest whole minute". A job that started therefore bills >= 1 minute.
 * Returns null when the job has no usable start/end (still queued or running).
 */
export function jobBillableMinutes(job) {
  const start = Date.parse(job?.started_at || '');
  const end = Date.parse(job?.completed_at || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = (end - start) / 1000;
  return Math.max(1, Math.ceil(seconds / 60));
}

/** Wall-clock seconds a job spent queued before it started (not billable). */
export function jobQueueSeconds(job) {
  const created = Date.parse(job?.created_at || '');
  const start = Date.parse(job?.started_at || '');
  if (!Number.isFinite(created) || !Number.isFinite(start) || start < created) return null;
  return Math.round((start - created) / 1000);
}

/**
 * Price a single job.
 * @returns {{minutes:number|null, costUsd:number, runner:object, unpriced:boolean, notes:string[]}}
 */
export function priceJob(job) {
  const runner = resolveRunner(job?.labels || [], job?.runner_group_name);
  const minutes = jobBillableMinutes(job);
  const notes = [];
  if (runner.note) notes.push(runner.note);
  if (minutes === null) notes.push('job has no completed_at yet; not billed in this snapshot');

  if (minutes === null || runner.perMinute === null) {
    return { minutes, costUsd: 0, runner, unpriced: runner.perMinute === null, notes };
  }
  const costUsd = round6(minutes * runner.perMinute);
  return { minutes, costUsd, runner, unpriced: false, notes };
}

/**
 * Aggregate a list of jobs into the numbers the dashboard and the invoice
 * estimator both need.
 */
export function summarizeJobs(jobs = [], opts = {}) {
  const plan = opts.plan && PLAN_ALLOWANCES[opts.plan] ? opts.plan : null;
  let grossCostUsd = 0;
  let largerCostUsd = 0;
  let standardCostUsd = 0;
  let standardMultipliedMinutes = 0;
  let selfHostedJobs = 0;
  let unpricedJobs = 0;
  const byOs = {};
  const bySku = {};
  for (const job of jobs) {
    const p = priceJob(job);
    if (p.unpriced) { unpricedJobs += 1; continue; }
    if (p.runner.kind === 'self-hosted') {
      selfHostedJobs += 1;
      byOs[p.runner.os || 'self-hosted'] = byOs[p.runner.os || 'self-hosted'] || { minutes: 0, costUsd: 0, jobs: 0 };
      byOs[p.runner.os || 'self-hosted'].jobs += 1;
      continue;
    }
    const m = p.minutes || 0;
    grossCostUsd += p.costUsd;
    const osKey = p.runner.os || 'unknown';
    byOs[osKey] = byOs[osKey] || { minutes: 0, costUsd: 0, jobs: 0 };
    byOs[osKey].minutes += m;
    byOs[osKey].costUsd = round6(byOs[osKey].costUsd + p.costUsd);
    byOs[osKey].jobs += 1;
    bySku[p.runner.sku] = bySku[p.runner.sku] || { minutes: 0, costUsd: 0, jobs: 0 };
    bySku[p.runner.sku].minutes += m;
    bySku[p.runner.sku].costUsd = round6(bySku[p.runner.sku].costUsd + p.costUsd);
    bySku[p.runner.sku].jobs += 1;

    if (p.runner.kind === 'larger') {
      largerCostUsd = round6(largerCostUsd + p.costUsd);
    } else {
      standardCostUsd = round6(standardCostUsd + p.costUsd);
      standardMultipliedMinutes += m * (OS_MINUTE_MULTIPLIER[p.runner.os] || 1);
    }
  }

  const allowance = plan ? PLAN_ALLOWANCES[plan].includedMinutes : null;
  // Estimated invoice. Larger runners are always charged outright and can never
  // draw on the included allowance. Standard runner minutes consume the
  // allowance (weighted by the OS multiplier); the portion covered by the
  // allowance is credited back proportionally. This is an explicit
  // approximation of GitHub's invoice, documented in docs/METHOD.md -- the
  // headline number everywhere in the product is the gross list cost, which
  // needs no assumption at all.
  let coveredFraction = 0;
  if (allowance && standardMultipliedMinutes > 0) {
    coveredFraction = Math.min(1, allowance / standardMultipliedMinutes);
  }
  const allowanceCreditUsd = round6(standardCostUsd * coveredFraction);
  const estimatedInvoiceUsd = round6(largerCostUsd + (standardCostUsd - allowanceCreditUsd));

  return {
    jobs: jobs.length,
    grossCostUsd: round6(grossCostUsd),
    standardCostUsd,
    largerCostUsd,
    standardMultipliedMinutes: Math.round(standardMultipliedMinutes),
    includedMinutes: allowance,
    allowanceCreditUsd,
    estimatedInvoiceUsd,
    unpricedJobs,
    selfHostedJobs,
    byOs,
    bySku,
    pricedAt: opts.pricedAt || null,
  };
}

/**
 * Linear month-end projection from month-to-date spend. Cheap, honest, and
 * labelled as a projection everywhere it is shown -- a projection is not a
 * measurement and the UI must not pretend otherwise.
 */
export function projectMonthEnd(monthToDateUsd, now = new Date()) {
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  if (day <= 0) return null;
  return { monthToDateUsd: round6(monthToDateUsd), projectedUsd: round6((monthToDateUsd / day) * daysInMonth), day, daysInMonth };
}

export function round6(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
}

/** Format money for display. */
export function usd(n, opts = {}) {
  const v = Number(n) || 0;
  const digits = opts.digits ?? (Math.abs(v) < 1 && v !== 0 ? 3 : 2);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
