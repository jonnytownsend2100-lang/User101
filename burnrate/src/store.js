// The store: everything that reads or writes tenant data goes through here, so
// there is exactly one place to audit for tenant isolation. It is an interface,
// not a class hierarchy, so a Postgres backend is a drop-in swap later.

import crypto from 'node:crypto';
import { hashKey, jsonOrNull, mapTenant, mapRun, mapJob, windowDaysFor } from './db.js';

export function makeStore(db) {
  const now = () => new Date().toISOString();
  const s = {
    upsertTenant: db.prepare(`INSERT INTO tenants (id, name, email, plan, status, created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email`),
    getTenant: db.prepare('SELECT * FROM tenants WHERE id = ?'),
    setPlan: db.prepare('UPDATE tenants SET plan = ?, status = ? WHERE id = ?'),
    setStripe: db.prepare('UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ?'),
    setInstallation: db.prepare('UPDATE tenants SET github_installation_id = ?, github_login = ? WHERE id = ?'),
    upsertRun: db.prepare(`INSERT INTO runs (tenant_id, id, attempt, repo, workflow_id, workflow_name,
        workflow_path, event, actor, branch, sha, conclusion, status, created_at, run_started_at,
        updated_at, queue_seconds, pr_numbers, is_fork)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, id, attempt) DO UPDATE SET conclusion=excluded.conclusion,
        status=excluded.status, updated_at=excluded.updated_at, queue_seconds=excluded.queue_seconds,
        pr_numbers=excluded.pr_numbers`),
    upsertJob: db.prepare(`INSERT INTO jobs (tenant_id, id, run_id, attempt, repo, name, conclusion, status,
        started_at, completed_at, labels, runner_group, steps, minutes, cost_usd, sku, os, kind, unpriced)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, id) DO UPDATE SET conclusion=excluded.conclusion, status=excluded.status,
        completed_at=excluded.completed_at, minutes=excluded.minutes, cost_usd=excluded.cost_usd,
        sku=excluded.sku, os=excluded.os, kind=excluded.kind, unpriced=excluded.unpriced`),
    addRepo: db.prepare(`INSERT INTO repos (tenant_id, full_name, private, default_branch, added_at)
      VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, full_name) DO UPDATE SET private=excluded.private,
      default_branch=excluded.default_branch`),
    listRepos: db.prepare('SELECT * FROM repos WHERE tenant_id = ? ORDER BY full_name'),
    removeRepo: db.prepare('DELETE FROM repos WHERE tenant_id = ? AND full_name = ?'),
    setSync: db.prepare(`INSERT INTO sync_state (tenant_id, repo, last_synced_at, newest_run_at, runs_synced, last_error)
      VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id, repo) DO UPDATE SET last_synced_at=excluded.last_synced_at,
      newest_run_at=COALESCE(excluded.newest_run_at, sync_state.newest_run_at),
      runs_synced=sync_state.runs_synced + excluded.runs_synced, last_error=excluded.last_error`),
    getSync: db.prepare('SELECT * FROM sync_state WHERE tenant_id = ? AND repo = ?'),
    listSync: db.prepare('SELECT * FROM sync_state WHERE tenant_id = ?'),
    setBudget: db.prepare(`INSERT INTO budgets (tenant_id, repo, monthly_usd, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(tenant_id, repo) DO UPDATE SET monthly_usd=excluded.monthly_usd, updated_at=excluded.updated_at`),
    listBudgets: db.prepare('SELECT * FROM budgets WHERE tenant_id = ?'),
    addKey: db.prepare('INSERT INTO api_keys (key_id, tenant_id, hash, prefix, name, created_at) VALUES (?,?,?,?,?,?)'),
    findKey: db.prepare('SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL'),
    touchKey: db.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_id = ?'),
    listKeys: db.prepare(`SELECT key_id, tenant_id, prefix, name, created_at, last_used_at FROM api_keys
      WHERE tenant_id = ? AND revoked_at IS NULL`),
    revokeKey: db.prepare('UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND tenant_id = ?'),
    audit: db.prepare('INSERT INTO audit_log (tenant_id, kind, detail, created_at) VALUES (?,?,?,?)'),
    listAudit: db.prepare('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?'),
    countRuns: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE tenant_id = ?'),
    countJobs: db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ?'),
  };
  return buildMethods(s, db, now);
}

function buildMethods(s, db, now) {
  return {
    raw: db,
    now,

    upsertTenant(t) {
      s.upsertTenant.run(t.id, t.name ?? null, t.email ?? null, t.plan || 'free', t.status || 'active', t.created_at || now());
      return this.getTenant(t.id);
    },
    getTenant(id) { const r = s.getTenant.get(id); return r ? mapTenant(r) : null; },
    setPlan(tenantId, plan, status = 'active') { s.setPlan.run(plan, status, tenantId); return this.getTenant(tenantId); },
    setStripe(tenantId, c, sub) { s.setStripe.run(c ?? null, sub ?? null, tenantId); return this.getTenant(tenantId); },
    setInstallation(tenantId, id, login) { s.setInstallation.run(String(id ?? ''), login ?? null, tenantId); return this.getTenant(tenantId); },

    addRepo(tenantId, repo) {
      s.addRepo.run(tenantId, repo.full_name, repo.private ? 1 : 0, repo.default_branch || null, now());
    },
    listRepos(tenantId) { return s.listRepos.all(tenantId).map((r) => ({ ...r, private: Boolean(r.private) })); },
    removeRepo(tenantId, fullName) { s.removeRepo.run(tenantId, fullName); },

    saveRun(tenantId, run) {
      s.upsertRun.run(tenantId, run.id, run.attempt || 1, run.repo,
        run.workflowId == null ? null : String(run.workflowId), run.workflowName, run.workflowPath,
        run.event, run.actor, run.branch, run.sha, run.conclusion, run.status, run.createdAt,
        run.runStartedAt, run.updatedAt, run.queueSeconds, jsonOrNull(run.prNumbers || []), run.isFork ? 1 : 0);
    },
    saveJobs(tenantId, jobs) {
      for (const j of jobs || []) {
        s.upsertJob.run(tenantId, j.id, j.runId, j.attempt || 1, j.repo, j.name, j.conclusion, j.status,
          j.startedAt, j.completedAt, jsonOrNull(j.labels || []), j.runnerGroup, j.steps, j.minutes,
          j.costUsd, j.sku, j.os, j.kind, j.unpriced ? 1 : 0);
      }
    },

    loadDataset(tenantId, { repos = null, since = null, until = null, limit = 5000 } = {}) {
      const where = ['tenant_id = ?'];
      const args = [tenantId];
      if (repos && repos.length) { where.push(`repo IN (${repos.map(() => '?').join(',')})`); args.push(...repos); }
      if (since) { where.push('created_at >= ?'); args.push(since); }
      if (until) { where.push('created_at <= ?'); args.push(until); }
      const runRows = db.prepare(`SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
        .all(...args, limit);
      if (!runRows.length) return { runs: [], windowDays: null };
      const runIds = [...new Set(runRows.map((r) => r.id))];
      const jobsByRun = new Map();
      for (let i = 0; i < runIds.length; i += 400) {
        const chunk = runIds.slice(i, i + 400);
        const ph = chunk.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM jobs WHERE tenant_id = ? AND run_id IN (${ph})`).all(tenantId, ...chunk);
        for (const j of rows) {
          const key = `${j.run_id}:${j.attempt}`;
          if (!jobsByRun.has(key)) jobsByRun.set(key, []);
          jobsByRun.get(key).push(mapJob(j));
        }
      }
      const runs = runRows.map((r) => ({ ...mapRun(r), jobs: jobsByRun.get(`${r.id}:${r.attempt}`) || [] }));
      return { runs, windowDays: windowDaysFor(runRows) };
    },

    setSyncState(tenantId, repo, st) {
      s.setSync.run(tenantId, repo, st.last_synced_at || now(), st.newest_run_at || null,
        st.runs_synced || 0, st.last_error || null);
    },
    getSyncState(tenantId, repo) { return s.getSync.get(tenantId, repo) || null; },
    listSyncState(tenantId) { return s.listSync.all(tenantId); },

    setBudget(tenantId, repo, monthlyUsd) { s.setBudget.run(tenantId, repo, monthlyUsd, now()); },
    listBudgets(tenantId) { return s.listBudgets.all(tenantId); },

    createApiKey(tenantId, { name = 'default' } = {}) {
      const keyId = crypto.randomUUID();
      const secret = crypto.randomBytes(24).toString('base64url');
      const prefix = `br_${secret.slice(0, 8)}`;
      const full = `${prefix}_${secret.slice(8)}`;
      s.addKey.run(keyId, tenantId, hashKey(full), prefix, name, now());
      return { keyId, apiKey: full, prefix };
    },
    verifyApiKey(presented) {
      if (typeof presented !== 'string') return null;
      const m = presented.match(/^(br_[A-Za-z0-9_-]{8})_/);
      if (!m) return null;
      const row = s.findKey.get(m[1]);
      if (!row) return null;
      const expected = Buffer.from(row.hash, 'hex');
      const actual = Buffer.from(hashKey(presented), 'hex');
      if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
      s.touchKey.run(now(), row.key_id);
      return { tenantId: row.tenant_id, keyId: row.key_id, name: row.name };
    },
    listApiKeys(tenantId) { return s.listKeys.all(tenantId); },
    revokeApiKey(tenantId, keyId) { s.revokeKey.run(now(), keyId, tenantId); },

    audit(tenantId, kind, detail) { s.audit.run(tenantId, kind, detail == null ? null : String(detail), now()); },
    listAudit(tenantId, limit = 100) { return s.listAudit.all(tenantId, limit); },
    counts(tenantId) { return { runs: s.countRuns.get(tenantId).n, jobs: s.countJobs.get(tenantId).n }; },
  };
}

