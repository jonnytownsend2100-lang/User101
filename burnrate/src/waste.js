// Waste detection: turn a cost dataset into a ranked list of dollars to cut.
//
// Two hard rules, because the credibility of the whole product rests on them:
//
//  1. monthlyUsd is COUNTED savings -- money we can point at with evidence and
//     arithmetic. It is conservative on purpose.
//  2. scenarioUsd is a SCENARIO -- real money, but it requires a human decision
//     (drop a cron frequency, move off macOS). It is never added to the counted
//     headline, because a number that requires a decision is not a saving yet.
//
// Findings with no dollar impact (slow queues) say so explicitly rather than
// being dressed up as savings.

export const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

// Extrapolating a 2-hour sample to a month produces confident nonsense. A cost
// tool that does that is worse than no tool, so monthly figures are only
// produced once the measured window is long enough to mean something.
function toMonthly(usd, windowDays, reliable) {
  if (!reliable || !windowDays || windowDays <= 0) return 0;
  return Math.round((usd / windowDays) * 30 * 100) / 100;
}

/**
 * @param {object} dataset
 * @param {Array} dataset.runs normalized runs: {id, attempt, workflowId, workflowName,
 *   event, actor, branch, sha, conclusion, createdAt, jobs:[{costUsd,...}]}
 * @param {number} dataset.windowDays
 */
export function detectWaste(dataset, opts = {}) {
  const runs = dataset.runs || [];
  const windowDays = dataset.windowDays || 0;
  const minWindowDays = opts.minWindowDays ?? 7;
  const reliable = windowDays >= minWindowDays;
  const runCost = (r) => (r.jobs || []).reduce((a, j) => a + (j.costUsd || 0), 0);
  const findings = [];

  // --- 1. Re-run waste (flaky tests / flaky infrastructure) -----------------
  // Any attempt beyond the first is compute you paid for because something was
  // unreliable. If the run eventually succeeded, earlier attempts bought you
  // nothing at all.
  const rerunRuns = runs.filter((r) => (r.attempt || 1) > 1);
  const rerunCost = rerunRuns.reduce((a, r) => a + runCost(r), 0);
  if (rerunCost > 0) {
    findings.push({
      id: 'rerun_waste',
      title: 'Re-runs caused by flaky tests or flaky infrastructure',
      severity: rerunCost / Math.max(1, totalCost(runs)) > 0.1 ? 'high' : 'medium',
      windowUsd: round2(rerunCost),
      monthlyUsd: toMonthly(rerunCost, windowDays, reliable),
      scenarioUsd: 0,
      evidence: {
        attempts: rerunRuns.length,
        runs: new Set(rerunRuns.map((r) => r.id)).size,
        windowCostUsd: round2(rerunCost),
        topWorkflows: topBy(rerunRuns, (r) => r.workflowName, runCost, 5),
      },
      recommendation: 'Quarantine the flakiest jobs, then fix or split them. Every re-run is pure cost with zero added signal.',
      confidence: 'high',
    });
  }

  // --- 2. Failed-run spend --------------------------------------------------
  const failed = runs.filter((r) => ['failure', 'timed_out', 'startup_failure'].includes(r.conclusion));
  const failedCost = failed.reduce((a, r) => a + runCost(r), 0);
  if (failedCost > 0) {
    const share = failedCost / Math.max(1e-9, totalCost(runs));
    findings.push({
      id: 'failed_run_spend',
      title: 'Compute burned by runs that failed',
      severity: share > 0.15 ? 'high' : share > 0.05 ? 'medium' : 'low',
      windowUsd: round2(failedCost),
      monthlyUsd: toMonthly(failedCost, windowDays, reliable),
      scenarioUsd: 0,
      evidence: {
        failedRuns: failed.length,
        windowCostUsd: round2(failedCost),
        shareOfSpend: round2(share * 100),
        topWorkflows: topBy(failed, (r) => r.workflowName, runCost, 5),
      },
      recommendation: 'Fail fast: run the cheapest, most failure-prone checks first so expensive jobs never start. Not all of this is waste -- some failures are the signal you pay CI for -- so treat it as an upper bound and a priority list.',
      confidence: 'medium',
    });
  }

  // --- 3. Duplicate runs for the same commit --------------------------------
  // Same workflow + same commit triggered more than once (the classic
  // push + pull_request double-trigger). One of them is redundant.
  let dupCost = 0;
  const dupExamples = [];
  for (const [, group] of groupBy(runs, (r) => `${r.workflowId}:${r.sha}`)) {
    if (group.length <= 1) continue;
    const distinctAttempts = new Set(group.map((r) => r.attempt || 1));
    if (group.length > distinctAttempts.size) {
      const costs = group.map(runCost).sort((a, b) => b - a);
      const wasted = costs.slice(1).reduce((a, b) => a + b, 0);
      dupCost += wasted;
      if (dupExamples.length < 5) {
        dupExamples.push({
          workflow: group[0].workflowName,
          sha: String(group[0].sha || '').slice(0, 7),
          occurrences: group.length,
          events: [...new Set(group.map((r) => r.event))],
          wastedUsd: round2(wasted),
        });
      }
    }
  }
  if (dupCost > 0) {
    findings.push({
      id: 'duplicate_triggers',
      title: 'The same commit runs the same workflow more than once',
      severity: 'medium',
      windowUsd: round2(dupCost),
      monthlyUsd: toMonthly(dupCost, windowDays, reliable),
      scenarioUsd: 0,
      evidence: { windowCostUsd: round2(dupCost), examples: dupExamples },
      recommendation: 'Add a concurrency group keyed on the commit and event, or narrow the trigger with paths/branches filters.',
      confidence: 'high',
    });
  }

  // --- 4. Runs superseded by a newer commit, never cancelled ----------------
  let rapidCost = 0;
  const rapidExamples = [];
  for (const [, group] of groupBy(runs, (r) => `${r.workflowId}:${r.branch}`)) {
    const sorted = [...group].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.sha === cur.sha) continue;
      const gap = Date.parse(cur.createdAt) - Date.parse(prev.createdAt);
      if (gap >= 0 && gap <= 15 * 60 * 1000) {
        rapidCost += runCost(prev);
        if (rapidExamples.length < 5) {
          rapidExamples.push({
            workflow: cur.workflowName, branch: cur.branch,
            gapMinutes: Math.round(gap / 60000), supersededCostUsd: round2(runCost(prev)),
          });
        }
      }
    }
  }
  if (rapidCost > 0) {
    findings.push({
      id: 'superseded_runs',
      title: 'Runs superseded by a newer commit that were never cancelled',
      severity: 'medium',
      windowUsd: round2(rapidCost),
      monthlyUsd: toMonthly(rapidCost, windowDays, reliable),
      scenarioUsd: 0,
      evidence: { windowCostUsd: round2(rapidCost), examples: rapidExamples },
      recommendation: 'Add `concurrency: { group: ${{ github.ref }}, cancel-in-progress: true }`. Usually a two-line fix and the fastest win in this report.',
      confidence: 'medium',
    });
  }


  // --- 5. Scenario: spend driven by scheduled workflows ----------------------
  // Real money, but cutting a cron cadence is a product decision, so it is a
  // scenario and never part of the counted headline.
  const scheduled = runs.filter((r) => r.event === 'schedule');
  const scheduledCost = scheduled.reduce((a, r) => a + runCost(r), 0);
  if (scheduledCost > 0) {
    findings.push({
      id: 'scheduled_workflow_spend',
      title: 'Spend driven by scheduled workflows',
      severity: 'low',
      monthlyUsd: 0,
      windowUsd: 0,
      scenarioUsd: toMonthly(scheduledCost * 0.5, windowDays, reliable),
      scenarioWindowUsd: round2(scheduledCost * 0.5),
      scenarioNote: 'assumes you halve the cadence of one or more scheduled workflows',
      evidence: {
        scheduledRuns: scheduled.length,
        windowCostUsd: round2(scheduledCost),
        topWorkflows: topBy(scheduled, (r) => r.workflowName, runCost, 5),
      },
      recommendation: 'Check whether every scheduled workflow needs its current cadence, and whether it should exit early when nothing changed.',
      confidence: 'medium',
    });
  }

  // --- 6. Scenario: macOS spend ---------------------------------------------
  // macOS lists at $0.062/min, over 10x Linux. Sometimes unavoidable
  // (Xcode/iOS). When it is not, it is the largest lever most teams have.
  const macosRuns = runs.filter((r) => (r.jobs || []).some((j) => j.os === 'macos'));
  const macosCostOf = (r) => (r.jobs || []).filter((j) => j.os === 'macos').reduce((x, j) => x + (j.costUsd || 0), 0);
  const macosCost = macosRuns.reduce((a, r) => a + macosCostOf(r), 0);
  if (macosCost > 0) {
    findings.push({
      id: 'macos_spend',
      title: 'macOS runner spend',
      severity: 'low',
      monthlyUsd: 0,
      windowUsd: 0,
      scenarioUsd: toMonthly(macosCost * 0.6, windowDays, reliable),
      scenarioWindowUsd: round2(macosCost * 0.6),
      scenarioNote: 'assumes 60% of macOS minutes can move to Linux or be cached away -- verify before believing it',
      evidence: {
        macosRuns: macosRuns.length,
        windowCostUsd: round2(macosCost),
        topWorkflows: topBy(macosRuns, (r) => r.workflowName, macosCostOf, 5),
      },
      recommendation: 'macOS bills at roughly 10x Linux. Keep it for Xcode/iOS; move everything else (lint, docs, Docker builds) to Linux.',
      confidence: 'low',
    });
  }

  // --- 7. Queue time: wall-clock waste with NO dollar impact ----------------
  const queued = runs.filter((r) => (r.queueSeconds || 0) > 300);
  if (queued.length) {
    const avgQueue = Math.round(queued.reduce((a, r) => a + r.queueSeconds, 0) / queued.length);
    findings.push({
      id: 'queue_latency',
      title: 'Long queue waits before jobs start',
      severity: 'low',
      monthlyUsd: 0,
      scenarioUsd: 0,
      evidence: { runsOver5Min: queued.length, avgQueueSeconds: avgQueue },
      recommendation: 'Queue time is not billed, so this costs developer waiting, not dollars. Worth fixing for velocity; do not count it as a saving.',
      confidence: 'high',
    });
  }

  return {
    findings: findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || (b.monthlyUsd - a.monthlyUsd)),
    countedWindowUsd: round2(findings.reduce((a, f) => a + (f.windowUsd || 0), 0)),
    countedMonthlyUsd: round2(findings.reduce((a, f) => a + f.monthlyUsd, 0)),
    scenarioMonthlyUsd: round2(findings.reduce((a, f) => a + (f.scenarioUsd || 0), 0)),
    windowDays,
    reliable,
    minWindowDays,
    note: reliable
      ? null
      : `Only ${windowDays} day(s) of runs loaded. Dollar-per-month figures are withheld until at least ${minWindowDays} days are synced; measured window costs are shown instead.`,
  };
}

function totalCost(runs) {
  return runs.reduce((a, r) => a + (r.jobs || []).reduce((x, j) => x + (j.costUsd || 0), 0), 0);
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function groupBy(arr, keyFn) {
  const m = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}
function topBy(arr, keyFn, valFn, n) {
  const m = new Map();
  for (const item of arr) {
    const k = keyFn(item) || '(unnamed)';
    m.set(k, (m.get(k) || 0) + valFn(item));
  }
  return [...m.entries()].map(([name, usd]) => ({ name, usd: round2(usd) }))
    .sort((a, b) => b.usd - a.usd).slice(0, n);
}

