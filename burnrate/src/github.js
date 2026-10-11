// Minimal, dependency-free GitHub REST client for reading Actions data.
//
// Design notes that matter for a paid product:
//  * Rate limits are real. A busy org can have 10k+ runs/month, and jobs cost
//    one request per run. We therefore support early-stop pagination and surface
//    remaining quota so sync can back off instead of dying mid-ingest.
//  * Secondary rate limits return 403 with a Retry-After. Retrying with backoff
//    is mandatory, not optional.
//  * Every request is bounded by a timeout so a hung socket cannot wedge a sync.

const DEFAULT_BASE = 'https://api.github.com';

export function resolveToken(env = process.env) {
  return env.BURN_RATE_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || null;
}

export class GitHubError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

export function makeClient(opts = {}) {
  const token = opts.token ?? resolveToken();
  const baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 3;
  const userAgent = opts.userAgent || 'burnrate/1.0 (+https://burnrate.dev)';
  const timeoutMs = opts.timeoutMs ?? 20000;
  let lastQuota = null;

  function recordQuota(headers) {
    const remaining = headers.get('x-ratelimit-remaining');
    if (remaining === null) return;
    lastQuota = {
      remaining: Number(remaining),
      limit: Number(headers.get('x-ratelimit-limit') || 0),
      resetAt: Number(headers.get('x-ratelimit-reset') || 0) * 1000,
    };
  }

  async function request(path, { params, method = 'GET', body } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const headers = {
        accept: 'application/vnd.github+json',
        'user-agent': userAgent,
        'x-github-api-version': '2022-11-28',
      };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body) headers['content-type'] = 'application/json';
      let res;
      try {
        res = await fetchImpl(url.toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt <= maxRetries) { await sleep(backoff(attempt)); continue; }
        throw new GitHubError(`network error: ${err.message}`, { path, status: 0 });
      }

      recordQuota(res.headers);
      if (res.status >= 200 && res.status < 300) {
        if (res.status === 204) return { data: null, headers: res.headers };
        const text = await res.text();
        return { data: text ? JSON.parse(text) : null, headers: res.headers };
      }

      const retryAfter = Number(res.headers.get('retry-after') || 0);
      const exhausted = res.headers.get('x-ratelimit-remaining') === '0';
      const retriable = res.status === 403 || res.status === 429 || res.status >= 500;
      if (retriable && attempt <= maxRetries) {
        if (exhausted) {
          const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
          const untilReset = Math.max(0, reset - Date.now());
          if (untilReset > 60000) {
            throw new GitHubError('primary rate limit exhausted; reset too far away to wait', {
              status: 403, path, body: { remaining: 0, resetAt: new Date(reset).toISOString() },
            });
          }
          await sleep(untilReset + 500);
        } else {
          await sleep(retryAfter ? retryAfter * 1000 : backoff(attempt));
        }
        continue;
      }
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      throw new GitHubError(`GitHub ${res.status} on ${path}: ${(parsed && parsed.message) || text}`, {
        status: res.status, body: parsed, path,
      });
    }
  }

  return {
    request,
    get quota() { return lastQuota; },
    getRepo: (repo) => request(`/repos/${repo}`).then((r) => r.data),
    getRateLimit: () => request('/rate_limit').then((r) => r.data),
    getAuthenticatedUser: () => request('/user').then((r) => r.data),

    /**
     * Iterate workflow runs newest-first, stopping as soon as we pass `since`.
     * With allAttempts we ask for every re-run attempt, which is what makes
     * flaky-test waste measurable.
     */
    async *iterateWorkflowRuns(repo, { since = null, perPage = 100, maxPages = 50, allAttempts = true } = {}) {
      const sinceMs = since ? Date.parse(since) : null;
      for (let page = 1; page <= maxPages; page += 1) {
        const { data } = await request(`/repos/${repo}/actions/runs`, {
          params: { per_page: perPage, page, filter: allAttempts ? 'all' : 'latest' },
        });
        const runs = data?.workflow_runs || [];
        if (!runs.length) return;
        let sawOlder = false;
        for (const run of runs) {
          const createdMs = Date.parse(run.created_at || '');
          if (sinceMs && Number.isFinite(createdMs) && createdMs < sinceMs) { sawOlder = true; continue; }
          yield run;
        }
        if (sawOlder || runs.length < perPage) return;
      }
    },

    /** All jobs for one run attempt (paginated). */
    async listJobs(repo, runId, attempt = 1) {
      const out = [];
      for (let page = 1; page <= 20; page += 1) {
        const path = attempt > 1
          ? `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs`
          : `/repos/${repo}/actions/runs/${runId}/jobs`;
        const { data } = await request(path, { params: { per_page: 100, page } });
        const jobs = data?.jobs || [];
        out.push(...jobs);
        if (jobs.length < 100) break;
      }
      return out;
    },

    /** Billable minutes as reported by GitHub. Reported as 0 for public repos. */
    getRunTiming: (repo, runId) => request(`/repos/${repo}/actions/runs/${runId}/timing`).then((r) => r.data),

    listWorkflows: (repo) => request(`/repos/${repo}/actions/workflows`, { params: { per_page: 100 } })
      .then((r) => r.data?.workflows || []),

    listOrgRepos: async (org, { perPage = 100, maxPages = 10 } = {}) => {
      const out = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const { data } = await request(`/orgs/${org}/repos`, { params: { per_page: perPage, page, type: 'all' } });
        if (!Array.isArray(data) || !data.length) break;
        out.push(...data);
        if (data.length < perPage) break;
      }
      return out;
    },

    listUserRepos: async (user, { perPage = 100, maxPages = 10 } = {}) => {
      const out = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const { data } = await request(`/users/${user}/repos`, { params: { per_page: perPage, page } });
        if (!Array.isArray(data) || !data.length) break;
        out.push(...data);
        if (data.length < perPage) break;
      }
      return out;
    },

    createIssueComment: (repo, issueNumber, bodyText) =>
      request(`/repos/${repo}/issues/${issueNumber}/comments`, { method: 'POST', body: { body: bodyText } })
        .then((r) => r.data),
  };
}

function backoff(attempt) {
  return Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

