# Swarm Node — git-backed persistent worker

A sandbox cannot be persistent. **The git repo is the node.**

Identity and state live in git (the only thing that survives teardown); the
process is reconstituted on each boot. No hosting provider, no extra
credentials — only `git`/`gh`, which are already authenticated.

## The one idea that makes this work

**An atomic push is a distributed lock.** Git guarantees a ref update either
succeeds or fails. So "claim a task" is implemented as:

    git push origin HEAD:refs/heads/swarm/claims/<taskId>

If two nodes race, exactly one push wins. The loser gets a non-fast-forward
rejection and backs off. That is mutual exclusion with no extra infrastructure.

## Protocol

| Path | Meaning |
|---|---|
| `swarm/inbox/<nodeId>/<taskId>.json` | task addressed to this node |
| `swarm/inbox/broadcast/<taskId>.json` | task any node may claim |
| `swarm/claims/<taskId>` | created by the winning push = the lock |
| `swarm/outbox/<nodeId>/<taskId>.result.json` | result |
| `swarm/heartbeat/<nodeId>.json` | liveness timestamp; stale ⇒ node down |
| `nodes/<nodeId>.json` | public identity + capabilities |

## Identity rule (non-negotiable)

The **public** key is committed. The **private** key is *never* committed —
it is injected as `SWARM_NODE_KEY` at boot. Without that rule the identity
is forgeable and the whole trust model collapses.

## Boot / rejoin

    read SWARM_NODE_ID, SWARM_NODE_KEY
    pull state
    heartbeat -> push
    loop: claim -> execute -> publish result -> commit state -> push

Resume is automatic: `nodes/<id>.state.json` holds the last processed task,
so a torn-down node picks up where it left off.

## Run it

    node swarm/node.js init                 # one-time: write identity descriptor
    node swarm/node.js run                  # boot, rejoin, process tasks
    node swarm/node.js status               # local view of state
    node swarm/node.js submit "do a thing"  # enqueue a broadcast task

## Honest limits

- **Durable, not always-on.** State survives; the process does not run between
  boots. True always-on needs a host outside the sandbox.
- **Git is a slow bus.** Seconds of latency plus push contention. Right for
  task handoff; wrong for tight parallel work.
- **Scale ceiling.** Beyond a handful of nodes, replace git-as-queue with a real
  bus (Redis/NATS/SQS) and keep git only for state and identity.
