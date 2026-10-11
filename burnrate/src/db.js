// Schema + database bootstrap. SQLite via node:sqlite -- built into Node 22+,
// so the whole product ships with zero runtime dependencies. That is deliberate:
// no supply chain to audit, no install step for a customer to get wrong, and it
// runs identically on a VPS, in Docker, or serverless with a mounted volume.
//
// Multi-tenancy is enforced in the schema itself (tenant_id is part of every
// primary key) rather than only in application code, because one missed WHERE
// clause in application code is how customer data leaks.

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT, email TEXT, plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active', github_login TEXT, github_installation_id TEXT,
  stripe_customer_id TEXT, stripe_subscription_id TEXT, trial_ends_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repos (
  tenant_id TEXT NOT NULL, full_name TEXT NOT NULL, private INTEGER DEFAULT 0,
  default_branch TEXT, added_at TEXT NOT NULL, PRIMARY KEY (tenant_id, full_name)
);
CREATE TABLE IF NOT EXISTS runs (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, repo TEXT NOT NULL,
  workflow_id TEXT, workflow_name TEXT, workflow_path TEXT, event TEXT, actor TEXT, branch TEXT, sha TEXT,
  conclusion TEXT, status TEXT, created_at TEXT, run_started_at TEXT, updated_at TEXT,
  queue_seconds INTEGER, pr_numbers TEXT, is_fork INTEGER DEFAULT 0,
  PRIMARY KEY (tenant_id, id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_runs_tenant_repo_created ON runs (tenant_id, repo, created_at DESC);
CREATE TABLE IF NOT EXISTS jobs (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  repo TEXT NOT NULL, name TEXT, conclusion TEXT, status TEXT, started_at TEXT, completed_at TEXT,
  labels TEXT, runner_group TEXT, steps INTEGER, minutes INTEGER, cost_usd REAL DEFAULT 0,
  sku TEXT, os TEXT, kind TEXT, unpriced INTEGER DEFAULT 0,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_run ON jobs (tenant_id, run_id, attempt);
CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, hash TEXT NOT NULL, prefix TEXT NOT NULL,
  name TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS budgets (
  tenant_id TEXT NOT NULL, repo TEXT NOT NULL, monthly_usd REAL NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, repo)
);
CREATE TABLE IF NOT EXISTS sync_state (
  tenant_id TEXT NOT NULL, repo TEXT NOT NULL, last_synced_at TEXT, newest_run_at TEXT,
  runs_synced INTEGER DEFAULT 0, last_error TEXT, PRIMARY KEY (tenant_id, repo)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT, kind TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
`;

export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

export const jsonOrNull = (v) => (v === undefined ? null : JSON.stringify(v));
export const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export function windowDaysFor(rows) {
  const dates = rows.map((r) => Date.parse(r.created_at || '')).filter(Number.isFinite);
  if (dates.length < 2) return null;
  const days = (Math.max(...dates) - Math.min(...dates)) / 86400000;
  return Math.max(1, Math.round(days));
}

export function mapTenant(r) {
  return {
    id: r.id, name: r.name, email: r.email, plan: r.plan, status: r.status,
    githubLogin: r.github_login, installationId: r.github_installation_id,
    stripeCustomerId: r.stripe_customer_id, stripeSubscriptionId: r.stripe_subscription_id,
    trialEndsAt: r.trial_ends_at, createdAt: r.created_at,
  };
}
export function mapRun(r) {
  return {
    id: r.id, attempt: r.attempt, repo: r.repo, workflowId: r.workflow_id, workflowName: r.workflow_name,
    workflowPath: r.workflow_path, event: r.event, actor: r.actor, branch: r.branch, sha: r.sha,
    conclusion: r.conclusion, status: r.status, createdAt: r.created_at, runStartedAt: r.run_started_at,
    updatedAt: r.updated_at, queueSeconds: r.queue_seconds, prNumbers: parseJson(r.pr_numbers, []),
    isFork: Boolean(r.is_fork),
  };
}
export function mapJob(r) {
  return {
    id: r.id, runId: r.run_id, attempt: r.attempt, repo: r.repo, name: r.name, conclusion: r.conclusion,
    status: r.status, startedAt: r.started_at, completedAt: r.completed_at, labels: parseJson(r.labels, []),
    runnerGroup: r.runner_group, steps: r.steps, minutes: r.minutes, costUsd: r.cost_usd,
    sku: r.sku, os: r.os, kind: r.kind, unpriced: Boolean(r.unpriced),
  };
}
