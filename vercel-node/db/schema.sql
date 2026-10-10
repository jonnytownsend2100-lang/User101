-- Vercel swarm node: task queue schema.
-- Atomic claiming is done with FOR UPDATE SKIP LOCKED (see lib/claim.js).

CREATE TABLE IF NOT EXISTS swarm_tasks (
  id              bigserial PRIMARY KEY,
  title           text        NOT NULL,
  payload         jsonb,
  state           text        NOT NULL DEFAULT 'pending',
  node_id         text,
  attempts        int         NOT NULL DEFAULT 0,
  claimed_at      timestamptz,
  next_attempt_at timestamptz,
  result          jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- Claim scan: pending work, expired leases, and backoff-elapsed retries.
CREATE INDEX IF NOT EXISTS swarm_tasks_claimable_idx
  ON swarm_tasks (created_at)
  WHERE state IN ('pending', 'claimed', 'failed');

-- Optional: node liveness, replacing the git heartbeat in ../swarm.
CREATE TABLE IF NOT EXISTS swarm_nodes (
  node_id     text PRIMARY KEY,
  region      text,
  last_seen   timestamptz NOT NULL DEFAULT now(),
  meta        jsonb
);
