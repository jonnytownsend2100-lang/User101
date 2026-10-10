# Test results (verified against origin, not just the working tree)

Run in-sandbox on 2026-10-10, node v24.21.0.

## 1. Persistence survives teardown — PASS
After `init` + `submit` + `run --once`, a **fresh clone of `origin`** contained:
- `swarm/outbox/node-e33252/t-…result.json` with `status: "done"`
- `nodes/node-e33252.state.json` with `processed: ["t-…"]`
- `nodes/node-e33252.json` identity descriptor

So node identity + state + results are genuinely reconstructable from git alone.

## 2. Mutual exclusion — PASS (with a caveat)
Two identities (`node-alpha`, `node-beta`) raced for one broadcast task:

    ALPHA  executing t-mv1t1xtz-85b4fa  -> published
    BETA   did not get …: already-claimed
    claims/ -> owned by node-alpha
    outbox/node-beta/ -> does not exist

Exactly one winner, loser did no work. **Caveat:** Beta was rejected by the
*local pre-check*, so the **push-rejection** path (the true distributed race)
was not exercised. That path is implemented (`reset --hard HEAD~1` on reject)
but untested. Treat as "guard verified, atomic backstop unproven."

## 3. Known defects (not hidden)
- **`pull --rebase --autostash` can conflict** during concurrent local runs;
  observed `git reset --hard to recover`. Needs per-node worktrees or a lock
  so parallel nodes never share one working tree.
- **`git push` intermittently fails** in this sandbox (transient network);
  no retry/backoff yet.
- **Working-tree reads are unreliable mid-rebase.** Early `cat` of state
  showed stale data; only a fresh clone reflected truth. Verify via clone.

## Verdict
Durable, git-backed, teardown-surviving node: **demonstrated.**
Distributed lock: **demonstrated via guard; atomic push path unproven.**
Production-ready: **no** — see defects. This is a working prototype.
