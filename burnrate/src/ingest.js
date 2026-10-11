// Ingest: GitHub payloads -> normalized, priced records that the store keeps.
//
// The normalization step is where two real-world traps get handled:
//  1. `run.pull_requests` is NOT a reliable "this run belongs to PR N" signal.
//     On scheduled runs of a busy repo it lists dozens of unrelated fork PRs.
//     We only trust an entry whose base repo is the repo we are looking at.
//  2. Re-runs arrive as separate list entries sharing an id and differing in
//     run_attempt, so the primary key must be id+attempt or retries vanish --
//     and retries are exactly what the waste report is built on.

import { priceJob } from './billing.js';

export function normalizeRun(run, repoFullName) {
  const createdAt = run.created_at || null;
  const runStartedAt = run.run_started_at || null;
  const qs = createdAt && runStartedAt
    ? Math.max(0, Math.round((Date.parse(runStartedAt) - Date.parse(createdAt)) / 1000))
    : null;
  const headRepo = run.head_repository?.full_name || null;
  return {
    id: String(run.id),
    attempt: run.run_attempt || 1,
    repo: repoFullName,
    workflowId: run.workflow_id ?? null,
    workflowName: run.name || '(unnamed)',
    workflowPath: run.path || null,
    event: run.event || null,
    actor: run.actor?.login || null,
    branch: run.head_branch || null,
    sha: run.head_sha || null,
    conclusion: run.conclusion || null,
    status: run.status || null,
    createdAt,
    runStartedAt,
    updatedAt: run.updated_at || null,
    queueSeconds: qs,
    prNumbers: extractPrNumbers(run, repoFullName),
    headRepo,
    isFork: Boolean(headRepo && repoFullName && headRepo !== repoFullName),
  };
}

export function extractPrNumbers(run, repoFullName) {
  const prs = Array.isArray(run?.pull_requests) ? run.pull_requests : [];
  const out = new Set();
  for (const pr of prs) {
    const baseRepo = pr?.base?.repo?.full_name || null;
    // Only trust PRs whose base is the repo we are syncing.
    if (repoFullName && baseRepo !== repoFullName) continue;
    if (Number.isFinite(pr?.number)) out.add(pr.number);
  }
  return [...out];
}

export function normalizeJob(job, run) {
  const priced = priceJob(job);
  return {
    id: String(job.id),
    runId: run.id,
    attempt: run.attempt,
    repo: run.repo,
    name: job.name || '(unnamed job)',
    conclusion: job.conclusion || null,
    status: job.status || null,
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null,
    labels: job.labels || [],
    runnerGroup: job.runner_group_name || null,
    steps: Array.isArray(job.steps) ? job.steps.length : null,
    minutes: priced.minutes,
    costUsd: priced.costUsd,
    sku: priced.runner.sku,
    os: priced.runner.os,
    kind: priced.runner.kind,
    unpriced: priced.unpriced,
  };
}

/**
 * Pull runs (and their jobs) for one repo into the store.
 *
 * `maxRuns` is a hard API budget, not a nicety: every run costs one extra
 * request to list its jobs, and our own GitHub quota is a real operating cost.
 * Hitting the budget is reported, never hidden.
 */
export async function syncRepo({ client, store, repo, since = null, maxRuns = 300, onProgress = null, tenantId = 'default' }) {
  const stats = { repo, runs: 0, jobs: 0, skipped: 0, costUsd: 0, budgetExhausted: false, unpricedJobs: 0, newestRunAt: null, oldestRunAt: null };
  for await (const raw of client.iterateWorkflowRuns(repo, { since, allAttempts: true })) {
    if (stats.runs >= maxRuns) { stats.budgetExhausted = true; break; }
    const run = normalizeRun(raw, repo);
    let jobs = [];
    try {
      const rawJobs = await client.listJobs(repo, run.id, run.attempt);
      jobs = rawJobs.map((j) => normalizeJob(j, run));
    } catch (err) {
      stats.skipped += 1;
      run.ingestError = String(err.message || err);
    }
    run.jobs = jobs;
    store.saveRun(tenantId, run);
    store.saveJobs(tenantId, jobs);
    stats.runs += 1;
    stats.jobs += jobs.length;
    stats.costUsd += jobs.reduce((a, j) => a + (j.costUsd || 0), 0);
    stats.unpricedJobs += jobs.filter((j) => j.unpriced).length;
    if (run.createdAt) {
      if (!stats.newestRunAt || run.createdAt > stats.newestRunAt) stats.newestRunAt = run.createdAt;
      if (!stats.oldestRunAt || run.createdAt < stats.oldestRunAt) stats.oldestRunAt = run.createdAt;
    }
    if (onProgress && stats.runs % 25 === 0) onProgress(stats);
  }
  stats.costUsd = Math.round(stats.costUsd * 1e6) / 1e6;
  return stats;
}
