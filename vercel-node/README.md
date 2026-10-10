# Vercel Swarm Node

A swarm worker that runs **on Vercel** instead of in an ephemeral sandbox.
Vercel supplies the four primitives the git-based prototype lacked.

## Why this works

| Swarm need | Git prototype | Vercel node |
|---|---|---|
| Wake / schedule | ✗ none (needed a host) | **Cron Jobs** — HTTP GET to your prod URL |
| Task transport | git branch (~seconds, contention) | **Queues** — durable log, at-least-once |
| Lock / claim | atomic `git push` (untested path) | `FOR UPDATE SKIP LOCKED` + lease |
| Isolation | shared worktree (**corrupted**) | fresh invocation per run |
| Long agent runs | one long process | **Workflows** — resume for months |
| Untrusted code | ✗ | **Sandbox** (isolated microVMs) |

The three defects I flagged in the git node are *structural non-issues* here:
concurrency corruption disappears because every invocation is isolated.

## Layout

    lib/claim.js       atomic claim: memory store + the real SKIP LOCKED SQL
    lib/store.pg.js    Postgres store + schema
    lib/worker.js      claim -> execute -> complete|fail, with a time budget
    lib/handlers.js    your actual work (edit this)
    api/worker.js      the node endpoint (cron- or queue-triggered)
    api/enqueue.js     submit a task
    test/              15 tests, all passing

## The claim, in one statement

Atomicity comes from Postgres, not application code:

```sql
UPDATE swarm_tasks SET state='claimed', node_id=$1, claimed_at=now(), attempts=attempts+1
 WHERE id = (SELECT id FROM swarm_tasks
              WHERE state='pending'
                 OR (state='claimed' AND claimed_at < now() - ($2||' ms')::interval)
                 OR (state='failed'  AND attempts < $3)
              ORDER BY created_at
              FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

`SKIP LOCKED` means N workers claim N distinct rows with no retries and no
double-delivery — strictly better than the git-push lock, which produced
rejected pushes and required rollback.

## Three ways to run it

**A. Cron polling** (simplest, what `vercel.json` ships)
Cron GETs `/api/worker` every 2 min; the node drains up to `SWARM_MAX_TASKS`.
Latency = cron interval. Good for batch/async work.

**B. Queue-driven** (event-driven, no polling lag) — Queues are beta on all plans
```js
import { send } from '@vercel/queue';
await send('swarm-tasks', { title: 'do a thing' });
```
```json
{ "functions": { "api/worker.js": {
    "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "swarm-tasks" }] } } }
```
`handleCallback` gives at-least-once delivery, automatic retries and
visibility timeouts for free — you can delete most of `lib/claim.js`.

**C. Workflow per task** (the answer for long agent runs)
Function duration is capped (see below), so anything that may run >5 min must
be a Workflow. Workflows are resumable across crashes *and deployments*:
```js
export async function agentTask(taskId) {
  'use workflow';
  const plan = await planStep(taskId);
  const patch = await editStep(plan);
  return await verifyStep(patch);
}
```

## Verified limits (from Vercel docs, this repo's review)

| Limit | Hobby | Pro / Enterprise |
|---|---|---|
| Function max duration | **300s default and max** | 300s default, **800s max**, 1800s extended (beta) |
| Function memory | 2 GB | 4 GB |
| Concurrency | 30,000 | 30,000 / 100,000+ |
| Regions | single (iad1) | multi-region |

- **Functions bill on active CPU time + provisioned memory time.** A cron worker
  that polls and finds nothing still costs invocations — keep the interval sane.
- **Cron Jobs**: available on all plans; Vercel issues an HTTP `GET` to the
  *production* deployment URL. Frequency caps vary per plan — **verify your plan's
  minimum interval before relying on fast polling** (I did not confirm exact numbers).
- **Queues**: beta on all plans; durable append-only log, consumer groups,
  fan-out, replay of non-expired history. Has **Poll Mode**, so a consumer can
  run *outside* Vercel and poll the topic.
- **Sandbox**: isolated microVMs — the correct place for untrusted code
  (Cursor Cloud Agents and Devin run on it).

## Setup

```bash
npm i                      # add `pg` and (optionally) `@vercel/queue`
psql "$DATABASE_URL" -f db/schema.sql
vercel env add DATABASE_URL        # Postgres (Neon/Supabase/Vercel Postgres)
vercel env add CRON_SECRET         # protects the cron endpoint
vercel --prod
```

Without `DATABASE_URL` the node falls back to an **ephemeral memory store** —
fine for a smoke test, useless across invocations. It logs a loud warning.

## Test

```bash
npm test        # 15 tests: claim, lease, backoff, dead-letter, budget, endpoint
```

## Honest gaps

- **The Postgres path is not exercised by tests.** `pgClaimSQL()` is the
  canonical pattern, but only the in-memory store is covered here (no Postgres
  in this sandbox). Proving `SKIP LOCKED` under real contention still needs a
  live database.
- **Never deployed.** I have no Vercel credentials — the GitHub proxy injects
  auth for GitHub only. Everything here is verified locally; `vercel --prod`
  is yours to run.
- **Cold starts** add latency to cron-triggered drains.
- **Cost is usage-based** and can spike if handlers fan out to LLM calls.
- The git node in `../swarm` is still the better choice for work needing a real
  filesystem checkout; this node is better for scheduling, fan-out, and scale.
