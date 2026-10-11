// Aggregation: from normalized runs+jobs to the tables a human (or an invoice)
// actually cares about. Pure functions, no I/O, so it is cheap to test and safe
// to run on every request.

import { summarizeJobs, projectMonthEnd, round6 } from './billing.js';

function sum(arr, fn) { return arr.reduce((a, x) => a + fn(x), 0); }

/** Cost of one normalized run (sum of its priced jobs). */
export function runCost(run) {
  return round6(sum(run.jobs || [], (j) => j.costUsd || 0));
}

/**
 * Roll a dataset up into every view the dashboard and the report show.
 * `now` is injectable so month-to-date math is deterministic in tests.
 */
export function aggregate(dataset, opts = {}) {
  const runs = dataset.runs || [];
  const now = opts.now ? new Date(opts.now) : new Date();
  const allJobs = runs.flatMap((r) => r.jobs || []);
  const totalCost = round6(sum(runs, runCost));

  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const mtdRuns = runs.filter((r) => Date.parse(r.createdAt || '') >= monthStart);
  const mtdCost = round6(sum(mtdRuns, runCost));

  const byDay = new Map();
  for (const r of runs) {
    const d = String(r.createdAt || '').slice(0, 10);
    if (!d) continue;
    const cur = byDay.get(d) || { date: d, costUsd: 0, runs: 0 };
    cur.costUsd = round6(cur.costUsd + runCost(r));
    cur.runs += 1;
    byDay.set(d, cur);
  }

  const daily = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const half = Math.floor(daily.length / 2);
  const trend = daily.length >= 4
    ? {
        recentDailyUsd: round6(sum(daily.slice(half), (d) => d.costUsd) / Math.max(1, daily.length - half)),
        earlierDailyUsd: round6(sum(daily.slice(0, half), (d) => d.costUsd) / Math.max(1, half)),
      }
    : null;
  if (trend) {
    trend.direction = trend.recentDailyUsd > trend.earlierDailyUsd * 1.1 ? 'up'
      : trend.recentDailyUsd < trend.earlierDailyUsd * 0.9 ? 'down' : 'flat';
    trend.changePct = trend.earlierDailyUsd > 0
      ? Math.round(((trend.recentDailyUsd - trend.earlierDailyUsd) / trend.earlierDailyUsd) * 100)
      : null;
  }

  const prCosts = new Map();
  for (const r of runs) {
    for (const pr of r.prNumbers || []) {
      const cur = prCosts.get(pr) || { pr, costUsd: 0, runs: 0 };
      cur.costUsd = round6(cur.costUsd + runCost(r));
      cur.runs += 1;
      prCosts.set(pr, cur);
    }
  }

  return {
    windowDays: dataset.windowDays || null,
    totals: {
      costUsd: totalCost,
      runs: runs.length,
      jobs: allJobs.length,
      minutes: Math.round(sum(allJobs, (j) => j.minutes || 0)),
      unpricedJobs: allJobs.filter((j) => j.unpriced).length,
      selfHostedJobs: allJobs.filter((j) => j.kind === 'self-hosted').length,
      failedRuns: runs.filter((r) => r.conclusion === 'failure').length,
      rerunRuns: runs.filter((r) => (r.attempt || 1) > 1).length,
      uniqueActors: new Set(runs.map((r) => r.actor).filter(Boolean)).size,
    },
    monthToDate: { costUsd: mtdCost, runs: mtdRuns.length },
    projection: projectMonthEnd(mtdCost, now),
    invoice: summarizeJobs(allJobs, { plan: opts.plan || null }),
    byWorkflow: rank(runs, (r) => r.workflowName || '(unnamed)', runCost),
    byBranch: rank(runs, (r) => r.branch || '(none)', runCost),
    byActor: rank(runs, (r) => r.actor || '(unknown)', runCost),
    byEvent: rank(runs, (r) => r.event || '(unknown)', runCost),
    byOs: rank(allJobs, (j) => j.os || 'unknown', (j) => j.costUsd || 0, (j) => j.minutes || 0),
    bySku: rank(allJobs, (j) => j.sku || '(unpriced)', (j) => j.costUsd || 0, (j) => j.minutes || 0),
    byRepo: rank(runs, (r) => r.repo || '(unknown)', runCost),
    daily,
    trend,
    prCosts: [...prCosts.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 20),
    mostExpensiveRuns: [...runs]
      .map((r) => ({
        id: r.id, attempt: r.attempt || 1, workflow: r.workflowName, branch: r.branch,
        sha: String(r.sha || '').slice(0, 7), event: r.event, actor: r.actor,
        conclusion: r.conclusion, createdAt: r.createdAt, costUsd: runCost(r),
        jobs: (r.jobs || []).length, minutes: Math.round(sum(r.jobs || [], (j) => j.minutes || 0)),
      }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 10),
  };
}

/** Group rows by key, total cost (and optional minutes), return sorted desc. */
export function rank(items, keyFn, valFn, minutesFn = null) {
  const m = new Map();
  for (const item of items) {
    const k = keyFn(item);
    const cur = m.get(k) || { name: k, costUsd: 0, count: 0, minutes: 0 };
    cur.costUsd = round6(cur.costUsd + valFn(item));
    cur.count += 1;
    if (minutesFn) cur.minutes += minutesFn(item);
    m.set(k, cur);
  }
  const rows = [...m.values()].sort((a, b) => b.costUsd - a.costUsd);
  const total = round6(sum(rows, (r) => r.costUsd));
  return rows.map((r) => ({ ...r, share: total > 0 ? Math.round((r.costUsd / total) * 1000) / 10 : 0 }));
}
