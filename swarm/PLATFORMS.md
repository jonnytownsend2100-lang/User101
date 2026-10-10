# Swarm Platforms: A Catalog of Compute Substrates We Can Bring Into the Swarm

> **Purpose.** The swarm currently runs on two substrates: a git-backed node
> (`swarm/node.js`) and a Vercel control plane with off-platform workers
> (`vercel-node/`). This document is a **deep, researched catalog of additional
> platforms** we can bring into the swarm, ranked by value and effort, with
> concrete architecture and implementation roadmaps.
>
> **Read first.** `swarm/README.md` (git-as-queue ethos, honest limits),
> `vercel-node/README.md` (why Vercel as control plane), and
> `vercel-node/docs/ADR-001-vercel-as-control-plane.md` (compute runs off-Vercel).

---

## 0. Executive summary

The swarm is *substrate-agnostic by design*: the only hard requirement is a
**transport** that can `receive(…) → ack(fail(…)) → heartbeat(…)` and a way for
the node to declare its identity (`nodes/<id>.json`, ed25519) and liveness.
Everything else is a plug-in.

**The five most valuable additions, in order:**

| # | Platform | Why now | Effort | What it buys |
|---|----------|---------|--------|--------------|
| 1 | **GitHub Actions runner node** | Free sandboxed compute; the swarm *lives* in GitHub — the runner is a native citizen. | Low | Burst compute with zero infra, 6-h job cap, git-native push-back. |
| 2 | **NATS gateway + NATS-backed store** | The README explicitly names NATS as the scale ceiling escape hatch. | Medium | Sub-ms task delivery, true horizontal scale, at-least-once delivery via pull-consumer acks. |
| 3 | **WasmCloud WASM worker node** | `repoTick` handlers warn "untrusted code belongs in Vercel Sandbox." WASM gives that sandbox everywhere, git-free. | Medium-High | Safe execution of untrusted payloads; language-agnostic workers. |
| 4 | **Edge nodes (Cloudflare Workers / Deno Deploy)** | Global, near-zero idle cost; cheap for poll-based nodes (blocked time ≈ free). | Medium | Worldwide distribution; cheap heartbeat + lightweight-task workers. |
| 5 | **Persistent containers (Docker Compose / K8s / any VPS)** | The daemon already runs there; it's the simplest "always-on" upgrade. | Low | 24/7 node without cron gaps; simple ops. |

**Cross-cutting enablers needed for several of these:** cryptographically-signed
node auth (ed25519-signed requests, verified against `nodes/<id>.json`),
capability-based task routing, and a metrics surface. These are cheap to build
and pay for themselves.

**Deliberate no's (boundary analysis, §8):** not a SaaS, not a general PaaS,
not a crypto/stress test farm (ToS), not a scraper. We keep git for identity +
durable state; the bus is a *transport concern*.

---

## 1. Current platform landscape

Two platforms ship today, plus the abstractions that make them swappable.

### 1.1 The git-backed node — `swarm/node.js`

- **Runtime:** an ephemeral `node` process. It boots, polls, works, exits — state
  survives because it lives in git.
- **Bus:** the git filesystem. Tasks appear as `swarm/inbox/{nodeId|broadcast}/*.json`;
  results go to `swarm/outbox/{nodeId}/*.result.json`.
- **Claim primitive:** **an atomic `git push` is a distributed lock.** Exactly one
  node wins; losers get a non-fast-forward rejection and back off.
- **Identity / liveness:** `nodes/<nodeId>.json` + `swarm/heartbeat/<nodeId>.json`;
  private key injected via `SWARM_NODE_KEY` (never committed).
- **Honest limits (from its README):** git latency (~seconds) + push contention;
  scale ceiling ~"a handful of nodes"; concurrent local runs can corrupt a shared
  worktree (`pull --rebase --autostash` conflict). Beyond a handful of nodes,
  *replace git-as-queue with a real bus and keep git only for identity/state*.

### 1.2 The Vercel control plane + off-Vercel workers — `vercel-node/`

ADR-001 decided: **Vercel is the control plane, not the workforce.** The control
plane supplies the four primitives the git node lacked:

| Swarm need | Git node | Vercel plane |
|---|---|---|
| Wake / schedule | none (needed a host) | **Cron Jobs** (`/api/worker` every 2 min) |
| Task transport | git branch (~seconds, contention) | **Queues** (durable log, at-least-once) or HTTP long-poll |
| Lock / claim | atomic `git push` (atomic path untested) | `FOR UPDATE SKIP LOCKED` + lease |
| Isolation | shared worktree (corrupted) | fresh invocation per run |
| Long agent runs | one long process | **Workflows** (resumable across crashes) |
| Untrusted code | none | **Sandbox** (isolated microVMs) |

The *workforce* runs **off Vercel** via Poll Mode: `makeHttpPollTransport` polls
`/api/inbox` from anywhere (sandbox, VPS, on-prem, another cloud), and
`daemon.mjs` wraps it into a long-lived loop with heartbeat + bounded concurrency.

### 1.3 The two hooks every new platform plugs into

```
┌─────────────────────────────────────────┐   ┌──────────────────────────────────────┐
│  transport layer (lib/transport.js)     │   │  claim/store layer (lib/claim.js)    │
│  receive({limit, visibilityMs})         │   │  enqueue(task)                       │
│  ack(messageId, result)                 │   │  claim({nodeId, lease}) ── ONE     │
│  fail(messageId, error)                 │   │    WINS per task (SQL / atomic)      │
│  heartbeat(nodeId, meta)                │   │  complete(taskId, result)            │
└─────────────────────────────────────────┘   │  fail(taskId, error)               │
                                              │  (nack → retry with backoff)          │
                                              └──────────────────────────────────────┘
```

- **Existing transports:** `http-poll` (polls `/api/inbox` — works from *any* host),
  `vercel-queue` (Vercel Queues Poll Mode, injected client shim), `memory` (tests).
- **Existing stores:** `makeMemoryStore` (tests), `makePgStore` (the canonical
  `UPDATE ... FOR UPDATE SKIP LOCKED LIMIT 1` statement).

**Design rule derived:** a new platform is either (a) a **new transport** (new
bus), or (b) a **new store**, or (c) a **new runner that reuses the existing
http-poll transport** (new runtime). Every candidate below is evaluated against
these hooks.

---

## 2. Evaluation axes

Each candidate is scored against six axes. Scores are narrative (Low/Medium/High),
with evidence cited where I verified it from source docs.

| Axis | Question |
|---|---|
| **Ethos fit** | Does it reinforce "git is the node / git is identity + state"? Zero extra infra is preferred. |
| **Abstraction reuse** | Can it reuse `makeHttpPollTransport` / `makePgStore` / `daemon.mjs`, or is there big new code? |
| **Latency / throughput** | Task-to-worker gap: git (~s) vs HTTP poll (sub-s to s) vs real bus (ms). |
| **Durability of work** | Can it survive process/node loss and requeue unacked work? |
| **Cost** | Free (incl. free tiers) vs paid. Note: *public repos = free GitHub Actions*. |
| **Risk** | ToS/ToU exposure, vendor lock-in, beta product status, blast radius. |

**Verified evidence used below** (all fetched from upstream docs this session):
- **GitHub Actions:** jobs run ≤6 h (`github/docs` `content/actions/reference/limits.md`);
  GitHub Actions is **free for public repos** and plan-based free minutes apply
  to private repos (`github/docs` `content/billing/concepts/product-billing/github-actions.md`).
- **NATS:** queue groups deliver each message to *exactly one* subscriber of the group
  (load-balanced worker pool); JetStream consumers give **at-least-once** delivery
  with ack/nack re-delivery; **pull consumers** are explicitly recommended for
  scalability, flow control and error handling (`nats-io/nats.docs`).
- **Cloudflare Workers:** CPU time = 10 ms / Free, 5 min max (default 30 s) / Paid;
  128 MB per-isolate; wall-clock HTTP duration has **no hard limit** while the
  client stays connected; network wait time doesn't count toward CPU time
  (`cloudflare/cloudflare-docs` `workers/platform/limits.mdx`).
- **wasmCloud:** portable WASM **components** implement stateless logic; abstract
  services (KV, HTTP, storage) come via **capability providers**; components run
  distributedly across languages (`wasmCloud/wasmcloud.com` components docs).
- **Deno Deploy:** edge serverless, isolated sandbox per invocation (limits
  unverified in this session — treat per-request limits as "verify").

Scoring key: `●` = strong fit / low = small; `○` = weak / high = big.

---

## 3. The candidate catalog

### Tier 1 — Ship these (high value, low effort, strongly aligned)

#### P1. GitHub Actions runner node — "the node is a GitHub Action"

**Concept.** A workflow job that clones the swarm repo, runs `node swarm/node.js run --once`
(or `node vercel-node/bin/swarmctl daemon --limit 1` against the control plane), and
pushes back the results. The swarm's own repo is the bus; GitHub Actions is the free,
sandboxed compute.

**Why it fits.** The swarm lives in GitHub; the runner is a *native citizen* with no
extra credentials (GITHUB_TOKEN, repo:push, is injected by the runner automatically).
The "git is the node" ethos gets stronger, not weaker.

**Verified limits:** jobs run ≤ 6 hours (`github/docs` `content/actions/reference/limits.md`);
GitHub Actions is **free for public repositories** (plan-based free minutes for private
repos — Free 2,000 / Pro 3,000 / Team 5,000 / Enterprise 30,000 min per month, roughly).

**What to build.**
- `workflows/swarm-runner.yml` — the workflow: on push to `swarm/inbox/broadcast/`
  (or on a schedule / cron), clone the repo, `node swarm/node.js run --once`, `git push`.
- Optional `workflows/swarm-runner-queue.yml` — trigger per new task file (repository_dispatch
  / webhook).
- A README section "Run nodes as GitHub Actions".

**Effort:** Low (~half a day). **Reuse:** none needed — it literally runs `swarm/node.js`.

**Risks / caveats.**
- Ephemeral filesystem: no long-running process; each task is a fresh job. Fine because
  git is the durable store.
- GITHUB_TOKEN push auth must have `Contents: write` (default on workflow runs in the repo).
- 6 h cap is plenty for task-sized work; long agent runs should be Vercel Workflows (§5.6).
- Rate limits: workflows are queued at 500 runs / 10 s / repo; bursty heavy usage could queue.

**Verdict:** The obvious first addition. It makes the swarm **self-hosting**: the repo can
run itself with zero outside infrastructure.

---

#### P2. NATS gateway + NATS-backed store — "the bus the README named"

**Concept.** A NATS server (single free binary) becomes the message layer; a new store
`lib/store.nats.js` implements the `enqueue / claim / complete / fail` interface using
JetStream **pull consumers** with ack/nack. Workers pull from a consumer subject; ack =
complete, nack / redelivery = retry with backoff. Git stays identity + durable state.

**Why it fits.** The git-node README says verbatim: *"Beyond a handful of nodes, replace
git-as-queue with a real bus (Redis/NATS/SQS) and keep git only for state and identity."*
This *is* that path, and NATS is the cheapest to self-host.

**Verified behavior (from nats-docs):**
- Core NATS **queue groups**: subscribers in one group get each message *exactly once* —
  a built-in load-balanced worker pool.
- **JetStream consumers** give at-least-once delivery with ack tracking; un-acked /
  nacked messages are redelivered.
- **Pull consumers** are the recommended default for scalability, flow control and error
  handling — a worker explicitly requests batches on demand, so the swarm's polling model
  maps 1:1 onto NATS.

**Architecture.**
```
task author ──POST /api/enqueue──► swarm control plane ──publish──► NATS stream "swarm.tasks"
                                                                 │
                         ┌──────────pull──────────────────┐   │   ┌──────────────┐
  worker ──makeNatsTransport► receive(batch) ──nack/ack──│◄──┴──►│ JetStream    │   │
                         ack(fail)                        │       │ consumer     │
                         heartbeat                        │       │ (at-least-   │   │
                         └────────────────────────────────┘       │  once)       │
                                                                 └──────────────┘
```

**What to build.**
- `vercel-node/lib/store.nats.js` (`makeNatsStore`): NATS JetStream stream + durable
  pull consumer; `claim()` = pull a batch, mark in-flight; `complete()` = ack;
  `fail()` = nack (nats-node.js `fail()` = nack (nats-node.js `claim()` returns a
  batch; the daemon's `tick()` acks each individually.
- `vercel-node/lib/transport.nats.js` (`makeNatsTransport`): wraps the JetStream JS client
  in the `receive/ack/fail/heartbeat` interface (heartbeats still go to `/api/nodes`).
- NATS deployment: `docker-compose.yml` + `nats.conf`, or a `nats` binary on a VPS.
- `VERCEL_STORE=nats` switch in `getStore()` / `createHandler()`?
- `VERCEL_STORE=nats` in `vercel-node/lib/stores.js`.

**Effort:** Medium (~1–2 days). **Reuse:** the store interface (claim/complete/fail) and
the daemon loop already handle ack/fail per message.

**Risks / caveats.**
- NATS is an additional runtime to operate — but it is a **single binary**, can be run
  on the same host as the control plane, and is free (Apache 2.0).
- At-least-once delivery: handlers must be idempotent or use the store's claims — the
  existing claim model already owns this (at-least-once + atomic claim).

**Verdict:** Highest architectural value; it is the documented scaling escape hatch.
Build it as the first "real bus" and let git nodes coexist as slow but zero-infra
fallbacks.

---

#### P3. Docker Compose / Kubernetes node — "the daemon you can run everywhere"

**Concept.** The `daemon.mjs` + http-poll transport already runs as a long-lived process
anywhere. This candidate = *bless it, containerize it, ship it*. A `docker-compose.yml`
and a Helm chart for the swarm control plane's node fleet.

**Why it fits.** Lowest-effort way to get always-on nodes; no new bus, no new runtime.
A container is a more robust "VPS" than bare `node daemon.mjs` on a shell.

**What to build.**
- `vercel-node/docker-compose.yml`: service running `node bin/swarmctl daemon`, env
  `SWARM_BASE_URL`, `SWARM_API_KEY`, `SWARM_NODE_ID`, healthchecks.
- `vercel-node/helm/` chart (optional): node deployment + `SwarmNode` CRD for per-node
  capability tags.
- Deployment guide ("run nodes on your VPS / K8s").

**Effort:** Low (config mostly; the code already exists). **Reuse:** 100% of `daemon.mjs`
and `makeHttpPollTransport`.

**Risks / caveats.** You operate the host (security, patching). For scale, prefer K8s.

**Verdict:** Trivial to ship and immediately useful; do it this week alongside P1.

---

### Tier 2 — High strategic value (medium effort)

#### P4. WasmCloud WASM worker node — "sandbox for untrusted code"

**Concept.** A node whose execute loop runs each task's payload as a **WebAssembly
component** via WasmCloud: actors/components get declared capabilities (filesystem,
HTTP, KV), and the WasmCloud host enforces isolation. This is the safe home for the
`repoTick` handler, which today says *"untrusted code belongs in Vercel Sandbox, not
here."*

**Why it fits.** Safety is a first-class swarm concern and WASM is the only truly
sandboxed, architecture-independent runtime we have. wasmCloud gives you a control
plane, capability providers (HTTP, key/value, filesystem, message bus), and language-
agnostic components (Rust, Go, Python, JS). **Verified:** components are portable WASM
binaries implementing stateless logic; capabilities are abstract reusable services
provided by capability providers; wasmCloud runs components distributedly.

**What to build.**
- `wasmcloud-node/` — a host process that (1) connects to a WasmCloud control plane,
  (2) subscribes to NATS subject `swarm.tasks` (or http-polls `/api/inbox`),
  (3) launches a component per task kind, (4) acks/nacks over NATS.
- A signature capability `swarm:execute` that the component implements.
- Handler bridge: `handlers.js` gets a `wasm` adapter that serializes payload → WASM
  call args; the component returns JSON.

**Effort:** Medium-High (~2–3 days, plus WasmCloud control-plane ops). **Reuse:**
the store + transport layers stay identical; only `execute()` changes.

**Risks / caveats.**
- New runtime + control plane to operate; learning curve for the component model.
- Interop: untrusted code returning signed JSON so the swarm can verify provenance.
- WASM components still have resource limits (memory, time) enforced by the runtime —
  good for safety.

**Verdict:** The right answer for the swarm's stated untrusted-code problem. Build
it after P2 (NATS) since NATS is also the WasmCloud control plane's message layer.

---

#### P5. Cloudflare Workers + Queues node — "global edge compute"

**Concept.** A worker that polls the swarm inbox (`/api/inbox` long-poll) — cheap because
blocked `fetch` time is *not* CPU time. Or, Workers Queues as a durable log with a
Queue consumer.

**Why it fits.** Verified limits (Cloudflare docs `workers/platform/limits.mdx`): **CPU
time = 10 ms / Free, up to 5 min (default 30 s) / Paid**; 128 MB per isolate; **wall-
clock HTTP duration has no hard limit** while the client holds the connection; Queues
consumers run up to 15 min. A poll-based node that mostly sleeps costs ≈ nothing.

**What to build.**
- `workers-node/worker.js`: long-lived `fetch('/api/inbox?limit=5&visibility=60000')`
  loop with `ctx.waitUntil()` for ack/fail; `navigator.storage` or KV for any state.
- `vercel-node/lib/transport.cf.js` (`makeCloudflareTransport`): same `receive/ack/fail`
  interface, backed by Workers fetch.
- Deployment: `wrangler.toml` targeting the swarm's control plane.

**Effort:** Medium (~1 day). **Reuse:** http-poll transport + store; the runtime is
different but the protocol is identical.

**Risks / caveats.**
- Free tier 10 ms CPU is useless for compute-heavy tasks; this is a **paid-feature**
  (~$20/mo Workers + Queues), so position it as "global, near-zero-idle-cost workers
  for lightweight tasks".
- Cold starts add latency to the poll loop.
- No long-term local filesystem; state must go to KV/Sites — or rely entirely on the
  control plane (cleaner).

**Verdict:** Great for distributing heartbeat + lightweight-task capacity worldwide;
not for CPU-heavy work on the free tier.

---

#### P6. Deno Deploy node — "edge, but Deno"

**Concept.** Identical shape to P5 but with the Deno runtime (native `fetch`, `std/`
utilities, `node:compat`). Edge serverless, isolated sandbox per invocation.

**Verified:** Deno Deploy is an edge, sandboxed isolate per function; per-request CPU
time limits apply. **Unverified in this session** (docs site is client-rendered and
the GitHub tree was unreachable) — treat limits as "verify before relying".

**What to build.** Same as P5 with a `deno` entrypoint; deploy to Deno Deploy; the
transport is http-poll over Deno's fetch.

**Effort:** Medium (config + runtime difference). **Reuse:** protocol + store.

**Risks / caveats.** Verify per-request time limits; Deno Deploy's pricing is
request- + GB-second-based, so a sleeping poll loop is cheap but each poll round-trip
bills.

**Verdict:** The Deno-flavored version of P5; keep as a fallback if the team prefers
Deno tooling.

---

#### P7. Browser node — "a literal swarm"

**Concept.** A web app (hosted on the swarm's Vercel deploy) whose *own browser tabs*
contribute idle compute: a Service Worker polls `/api/inbox`, executes tasks, reports
back. Contributors opt in; the swarm literally runs on your team's laptops.

**Why it fits.** Zero infra cost; the name "swarm" finally means a swarm of devices.
The control plane is already served over HTTP — the browser is just another http-poll
client.

**What to build.**
- `browser-node/` — SPA + Service Worker that fetches tasks on a schedule / on `pageshow`;
  `self.registration.sync.register('swarm-poll')` for background work; `ctx.waitUntil()`
  equivalents via Service Worker event lifecycles.
- `lib/transport.browser.js` (`makeBrowserTransport`): same interface, using the SW's
  fetch + background sync.
- Security: **only run tasks the swarm owner trusts** (a browser can be inspected by
  its owner — no isolation). Gate by org membership token.

**Effort:** Medium (~1–2 days). **Reuse:** transport interface + store.

**Risks / caveats.**
- Browser event lifecycles are finite (background sync ≈ seconds-to-a-few-minutes window;
  fetch in the SW is bounded by OS/browser scheduling). Best for small, short tasks.
- Must be opt-in and clearly auditable — users must know they're contributing compute.

**Verdict:** Fun and zero-cost, but bounded. A nice "community / hobby" mode rather than
production capacity.

---

#### P8. AWS SQS + Lambda / Fargate node — "the other real-bus option"

**Concept.** SQS as the durable queue (workers poll SQS, poll `SWARM_TASKS` queue with
visibility timeout = lease; `ReceiveMessage` returns a batch; `DeleteMessage` = ack,
leave in queue + backoff = fail). Compute on Lambda (stateless) or Fargate (persistent).

**Why it fits.** It's the third option named in the README's escape hatch. Good if the
org is already AWS-heavy. At-least-once + visibility timeout ≈ the swarm's lease model.

**What to build.**
- `lib/store.sqs.js` / `makeSqsStore`: SQS `ReceiveMessage` (visibility timeout as
  lease) → claim; `DeleteMessage` → complete; requeue after backoff → fail.
- `lib/transport.sqs.js` (optional; SQS is the bus so a transport is usually redundant).
- Terraform/CDK for the queue + IAM roles.

**Effort:** Medium-High (~2 days + AWS setup). **Reuse:** store interface.

**Risks / caveats.** AWS account needed; IAM complexity; cost on usage. Adds a cloud
vendor dependency the swarm currently avoids.

**Verdict:** Build if AWS is already in play; otherwise NATS (P2) is cheaper and
vendor-neutral.

---

### Tier 3 — Niche / experimental (build if a specific need emerges)

#### P9. Chat/social node (Telegram / Discord / Slack bot)

**Concept.** A bot in a team channel that enqueues tasks from chat (`!do fix auth`) and
posts results/links back. Turns the swarm into a conversational teammate.

**Why it fits.** Zero infra cost (host the bot on the existing control plane host or a
cheap VPS); it *is* a new transport (`receive` = listen to chat events). Great for
making the swarm discoverable.

**What to build.** `chat-node/` with a `makeChatTransport` (discord.js / @slack /
telegram bot) + a small scheduler to post results. Node id → channel mapping in the
control plane registry.

**Effort:** Low-Medium (~1 day). **Reuse:** transport interface only.

**Risks / caveats.** Rate limits & ToS of the chat platform; noisy; bot account security.

**Verdict:** A fun, low-cost way to lower the entry barrier for non-technical users.

---

#### P10. Email node

**Concept.** Tasks arrive via email (IMAP/SMTP); results returned by email. Niche, but
email remains a ubiquitous, always-available transport.

**What to build.** `lib/transport.email.js`: poll IMAP for a labelled folder → enqueue;
reply with result JSON.

**Effort:** Low-Medium. **Reuse:** transport interface.

**Risks / caveats.** Async, low bandwidth; reply-to address must resolve to the swarm.

**Verdict:** Keep as a "legacy channel" experiment; probably the least needed.

---

#### P11. MQTT edge node

**Concept.** A node listening to NATS-compatible MQTT (NATS is MQTT-interoperable) on
IoT/edge devices. Tasks flow `MQTT → NATS stream → worker`.

**What to build.** If we ship NATS, an MQTT-bridge server already gives this for free;
edge devices subscribe to `swarm.tasks` via MQTT.

**Effort:** Low (if NATS ships). **Reuse:** NATS bridge.

**Risks / caveats.** Devices must be able to reach the broker.

**Verdict:** Worth nothing by itself; a free byproduct of P2.

---

#### P12. GitHub Codespaces node

**Concept.** A persistent Codespace running `node swarm/node.js run` (or the daemon) in
a full dev container; commits back to the repo every N minutes. Each developer has a
node in their own environment.

**Why it fits.** Codespaces already exist in the GitHub ecosystem; the git-node runs
verbatim. Free tier gives ~60 hours/month.

**What to build.** `codespaces/.devcontainer/devcontainer.json` + a boot script that
starts the node and commits on a timer.

**Effort:** Low (~half day). **Reuse:** `swarm/node.js` verbatim.

**Risks / caveats:** Codespaces usage caps; ephemeral when closed.

**Verdict:** Nice for a "every dev runs a node locally" model; good companion to P1.

---

#### P13. Desktop node (Tauri / Electron)

**Concept.** A desktop app that runs the node daemon on a developer's machine,
contributing idle cycles (think Folding@Home-ish, but for swarm tasks).

**What to build.** Tauri wrapper around `daemon.mjs` + a tray UI showing capacity + liveness.

**Effort:** Medium. **Reuse:** `daemon.mjs`.

**Risks / caveats.** Desktop apps are hard to distribute; user machine quality varies;
must be clearly opt-in with resource limits (CPU throttle).

**Verdict:** Ambitious; deprioritize unless a clear desktop-first use case appears.

---

#### P14. Coordinator / orchestrator node — "the swarm brain"

**Concept.** A meta-node that watches `nodes/<id>.json` and heartbeats, detects stale
nodes, triggers reclaims of abandoned claims, routes tasks to capable nodes
(capability-based scheduling), and emits metrics.

**Why it fits.** Not a compute platform per se, but the swarm lacks a coordinator today.
It makes *all* other platforms safer (zombie-claim cleanup, load balancing).

**What to build.** `coordinator/`: a loop that lists nodes, checks staleness against
`swarm/heartbeat/` and `/api/nodes`, computes a capability index, and re-claims tasks
whose claim file is older than the lease.

**Effort:** Medium. **Reuse:** existing git paths + registry API.

**Risks / caveats.** Adds a single point of failure — keep it simple and stateless.

**Verdict:** Worth building early; it protects the other platforms' investments.

---

#### P15. Metrics / observability platform

**Concept.** Every node pushes counters (tasks received/done/failed, cycles, heartbeat
age) into a durable store; a dashboard (`/dashboard`) shows fleet health.

**Why it fits.** Currently there is **no metrics surface** — the swarm is blind
between heartbeats. This is the cheapest way to get visibility into *any* new platform.

**What to build.** `lib/metrics.js`: an append-only store (Postgres `swarm_metrics` or
S3 objects) + a `/api/metrics` GET for a dashboard. Node pushes a line each cycle.

**Effort:** Low (~1 day). **Reuse:** transport heartbeat slot.

**Risks / caveats.** Metrics data hygiene (dedup, ordering).

**Verdict:** Ship alongside the first Tier-2 platform — it makes everything else
measurable.

---

## 4. Cross-cutting enablers (make the above possible)

### E1. Cryptographically-signed node authentication (highest priority)

**Current.** Nodes authenticate to `/api/inbox` / `/api/nodes` with an `x-api-key` header.
That key is shared with whoever holds it — a leaked key lets anyone inject or steal
tasks.

**Proposal.** Each node *already* has an ed25519 key pair (private key injected,
public key committed to `nodes/<id>.json`). Make the node sign every request with its
private key; the control plane verifies the signature against the committed public key
and asserts `sub == nodeId`.

```
node:   payload = {action:"claim", nodeId, ts}
        sig = ed25519.sign(payload, privateKey)
        req.headers['x-swarm-sig'] = sig
        req.headers['x-swarm-node'] = nodeId
control: pub = nodes[nodeId].publicKey
        if !verify(pub, req.body, sig) → 401
        if req.body.nodeId != nodeId → 401
        if Date.now() - req.body.ts > 60s → 401
```

**Why it matters.** This is what makes a node *prove* it is that node — matching the
README's identity rule: *"Without that rule [public committed, private never committed]
the identity is forgeable and the whole trust model collapses."* It also enables
**capability attestation**: a node can attach a signed claim "I can run wasm:repoTick"
which the coordinator uses for routing.

**Effort:** ~1 day. **Reuse:** existing ed25519 identity + `sha()` helpers.

---

### E2. Capability-based task routing

**Current.** `submit()` puts a task in `inbox/broadcast/` (or `inbox/<nodeId>/`);
*every* node that sees it can claim it. A `kind: 'wasm:repoTick'` task can be claimed
by a Node.js node that cannot run it.

**Proposal.** The coordinator builds a `nodes/<id>.capabilities` index from the
identity descriptors and the scheduler routes `kind` → capability-matched nodes only.
Add `task.kind` routing to `/api/enqueue` and `store.claim()` filters.

**Effort:** ~1 day (coordinator already computes liveness; just add a capability index).

---

### E3. Result signing / provenance

**Current.** `swarm/outbox/<nodeId>/*.result.json` is public but not signed.

**Proposal.** Nodes sign each result with their private key (`result.sig`); consumers
verify before acting. Cheap, and makes results tamper-evident — important when results
drive downstream work.

**Effort:** ~4 h.

---

## 5. Boundary analysis: what the swarm should NOT become

ADR-001 already bounded the Vercel relationship. This extends the boundary to the
platform catalog — a checklist for evaluating any future candidate:

1. **Not a SaaS.** We are not building a task queue product for third parties.
   Every new platform is a place *our* nodes run. If a candidate is primarily about
   selling capacity, it's out of scope.
2. **Not a general-purpose PaaS.** We do not need to support arbitrary deployments.
   Platforms are chosen for how well they host *swarm nodes*, not how broadly.
3. **No ToS-hostile compute.** The ADR flagged that "a high-frequency, machine-shaped
   worker fleet is structurally indistinguishable from" scrapers/load-testing under
   fair-use policies. We do not run scrapers, proxies, password crackers, crypto
   mining, or stress tests on someone else's platform. Our handlers do real application
   work (DB/API/agent steps) — and we say so when we onboard a platform.
4. **Git stays identity + durable state.** Whether the bus is git, NATS, or SQS, the
   commit that writes `nodes/<id>.json`, `swarm/heartbeat/<id>.json`, and
   `swarm/outbox/<id>/*.result.json` is the source of truth. A platform that wants to
   drop git entirely loses the "the repo is the node" property — worth resisting unless
   there is a compelling reason.
5. **No vendor lock-in that breaks the bus.** If the transport can be swapped for another
   in a few days (NATS ↔ SQS ↔ Redis), the platform is fine. If using Platform X means
   we can never migrate the bus, be skeptical.
6. **Free-first, paid-optional.** Free tiers (GitHub Actions on public repos, free NATS
   binary, free browser) are preferred; paid edge platforms (Cloudflare Paid, Deno
   Deploy) are positioned as optional upgrades, never as dependencies.
7. **No untrusted-node execution of our code.** A node running untrusted *tasks*
   (P4) is fine in WASM; untrusted *nodes* writing into the repo are not — that's the
   reason the private key is never committed and the identity rule is non-negotiable.

Anything that fails one of these bars goes to the backlog, not the roadmap.

---

## 6. Architecture: how the platforms fit together

```
                                ┌──────────────────────────────────────────────────┐
                                │  SWARM CONTROL PLANE  (any host)                 │
                                │  /api/enqueue   POST  {title, kind, payload}     │
                                │  /api/inbox     GET   lease a batch of tasks     │
                                │  /api/nodes     liveness + registry              │
                                │  └─ store: pg (default) │ nats │ sqs │ memory   │
                                └───────────┬──────────────────────────────────────┘
                                            │  HTTP long-poll (ed25519-signed)
                ┌───────────────────────────┼───────────────────────────┌───────────┐
                │                           │                           │           │
      ┌─────────▼──────┐      ┌─────────────▼───────────┐      ┌────────▼────┐  ┌─────▼─────────┐
      │  git node      │      │  VPS / container node   │      │  edge node  │  │  browser node │
      │  swarm/node.js │      │  daemon + http-poll     │      │  cf / deno  │  │  service wrkr │
      └────────┬───────┘      └─────────────┬───────────┘      └─────────────┘  └───────────────┘
               │                            │
      git push = lock                     NATS pull → ack/nack  (or /api/inbox)
               │                            │
               └──────────────┬─────────────┘
                              │
                   ┌──────────▼───────────┐
                   │  message bus         │  ← swappable: git │ NATS │ SQS │ Redis
                   └──────────────────────┘
                              │
                   ┌──────────▼───────────┐
                   │  durable state       │  ← git repo (identity + state + results)
                   └──────────────────────┘
```

All runners converge on the same store interface and the same transport interface —
adding a platform is mostly *one file* once E1–E3 land.

---

## 7. Roadmap

| Phase | Weeks | Items | Outcome |
|-------|-------|-------|---------|
| **0** | 0–1 | E1 (node sig auth), E3 (result sig) | Every new node can cryptographically prove identity; results tamper-evident. |
| **1** | 1–2 | P1 (GitHub Actions runner), P3 (docker-compose/K8s) | Swarm can run itself with zero external infra; always-on container nodes. |
| **2** | 2–4 | P2 (NATS gateway + `makeNatsStore` + `makeNatsTransport`) | Documented real-bus path; scale past the "handful of nodes" ceiling. |
| **3** | 4–6 | P15 (metrics) + P14 (coordinator with re-claim) | Fleet visibility; zombie-claim cleanup; capability index. |
| **4** | 6–9 | P4 (WasmCloud WASM node) | Safe home for `repoTick`/untrusted payloads. |
| **5** | 8–11 | P5 (Cloudflare Workers node), P6 (Deno Deploy node) | Global, cheap edge capacity. |
| **6** | 10+ | P7 (browser), P9 (chat bot), P12 (Codespaces), P13 (desktop) | Fun, low-cost extensions; community modes. |

**Critical path:** E1 → P1/P3 (week 1–2) → P2 (week 2–4). Everything else is
optional and gated on real demand.

---

## 8. Summary table

| ID | Platform | Bus | Compute | Free | Effort | Verdict |
|----|----------|-----|---------|------|--------|---------|
| P1 | GitHub Actions runner | git | GH-hosted job (6 h) | **yes (public)** | Low | **Ship now** |
| P2 | NATS gateway + store | **NATS** | any host | yes (binary) | Medium | **Ship now** |
| P3 | Docker/K8s node | http-poll | persistent container | yes (your infra) | Low | **Ship now** |
| P4 | WasmCloud WASM node | NATS/http | WASM component | yes (self-host) | Med-High | Build after P2 |
| P5 | Cloudflare Workers | http-poll | edge isolate (30s–5 min CPU) | no (free = 10 ms) | Medium | Paid edge upgrade |
| P6 | Deno Deploy | http-poll | edge isolate | no (verify limits) | Medium | Deno-flavored P5 |
| P7 | Browser node | http-poll | browser | yes | Medium | Community mode |
| P8 | AWS SQS + Lambda/Fargate | **SQS** | Lambda / Fargate | no | Med-High | Only if AWS-native |
| P9 | Chat/social bot | chat | existing host | yes | Low-Med | Lower barrier |
| P10 | Email node | email | existing host | yes | Low-Med | Least needed |
| P11 | MQTT edge node | MQTT/NATS | edge device | yes | Low (if P2) | NATS byproduct |
| P12 | GitHub Codespaces | git | Codespace | ~60 h/mo | Low | Companion to P1 |
| P13 | Desktop node (Tauri) | http-poll | desktop app | yes | Medium | Deprioritize |
| P14 | Coordinator | git + registry | existing host | yes | Medium | Build early |
| P15 | Metrics platform | pg/S3 | existing host | yes | Low | Measure first |

Enablers: E1 (node auth), E2 (capability routing), E3 (result signing).

---

*Prepared from direct reads of the swarm repo, the Vercel node, ADR-001, and upstream
documentation (GitHub Actions limits + billing, NATS queue groups & JetStream
consumers, Cloudflare Workers platform limits, wasmCloud components & capabilities).*
---

## Appendix A: Prototype artifacts (ready to adapt)

### A.1 `workflows/swarm-runner.yml` — GitHub Actions runner node

```yaml
# .github/workflows/swarm-runner.yml
name: swarm-runner
# Runs on a schedule; extend triggers to "push on swarm/inbox/broadcast/*" or
# "repository_dispatch" for task-driven execution.
on:
  schedule: [{ cron: '*/5 * * * *' }]
  push:
    branches: [cline/xe92gsgj]
    paths: ['swarm/inbox/broadcast/**']

jobs:
  swarm:
    runs-on: ubuntu-latest
    permissions:
      contents: write   # lets the runner git-push results back to this repo
      id-token: write   # (optional) for OIDC token auth on AWS/etc.
    steps:
      - name: Checkout the swarm repo (the bus)
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with: { node-version: '20' }

      # Boot as a node with a stable identity so reclaims can find it.
      - name: Init / run node
        run: |
          export SWARM_NODE_ID=gh-runner-${{ github.run_id }}
          node swarm/node.js init
          node swarm/node.js run --once

      # Results land in swarm/outbox/<nodeId>/*.result.json and get committed
      # by the run above. If the swarm has a Vercel control plane, a second
      # step can `node bin/swarmctl daemon` against it instead.
```

Notes for adoption:
- `SWARM_NODE_ID` must be stable across restarts for re-claim logic to work;
  use `${{ github.run_id }}` (ephemeral-but-unique) or a persistent env.
- The job's `git push` happens automatically via the checked-out repo; results
  are committed by `swarm/node.js`'s own `commitAndPush()` — no separate step.
- Public repo → free; private repo → the repo owner's Actions minutes.

### A.2 `lib/store.nats.js` — NATS-backed store (interface sketch)

```js
import { connect } from 'nats';   // npm: nats

/**
 * NATS store: JetStream stream "swarm.tasks" + durable pull consumer
 * "swarm-workers". claim() = pull one message + mark in-flight; complete() = ack;
 * fail()  = nack so the consumer redelivers. The swarm's lease/retry model maps
 *           1:1 onto NATS at-least-once + nack requeue.
 */
export function makeNatsStore({
  natsUrl = process.env.NATS_URL ?? 'nats://localhost:4222',
  stream = 'swarm.tasks',
  consumer = 'swarm-workers',
  pullBatch = 5,
  pending = 1000,
  expiry = 10_000,       // pull consumer wait (ms); ~ lease granularity
} = {}) {
  const inflight = new Map();   // taskId -> { nodeId, claimedAt, deliverAt }
  let nc, js;

  async function ensure() {
    if (nc?.isConnected()) return;
    nc = connect({ servers: natsUrl, name: 'swarm-store' });
    await nc.connected;
    js = nc.jetstream();
    await js.streams.add({ name: stream, subjects: [`${stream}.*`], max_bytes: 100e6 });
    await js.consumers.get(stream, consumer);  // durable pull consumer (pre-created)
  }

  async function* pullMessages() {
    await ensure();
    for await (const m of js.pull(stream, consumer, { batch: pullBatch, pending, expiry })) {
      yield m;
    }
  }

  return {
    kind: 'nats',
    async enqueue(task) {
      await ensure();
      await js.publish(`${stream}.${Date.now()}`,
        JSON.stringify({ title: task.title, payload: task.payload }));
    },
    async claim({ nodeId, lease = 60_000 }) {
      for await (const m of pullMessages()) {
        const task = JSON.parse(m.data);
        inflight.set(task.taskId, { nodeId, claimedAt: Date.now(), deliverAt: Date.now() + lease });
        return { ...task, attempts: 1 };
      }
      return null;
    },
    async complete(taskId, result) {
      const m = inflight.get(taskId);
      if (m) { m.ack(); inflight.delete(taskId); }
    },
    async fail(taskId, error) {
      const m = inflight.get(taskId);
      if (m) { m.nack(); inflight.delete(taskId); }  // redelivered → retry with backoff
    },
  };
}
```

### A.3 `lib/transport.nats.js` — NATS transport (interface sketch)

```js
/** Wraps the NATS JetStream pull consumer in the swarm's receive/ack/fail/heartbeat interface.
 * Heartbeats still ride the control plane (/api/nodes) so the registry stays vendor-neutral. */
export function makeNatsTransport({ natsUrl, stream, consumer, limit = 5 }) {
  const inflight = new Map();  // taskId -> { messageId, data }
  let nc, js;
  async function ensure() {
    if (nc?.isConnected()) return;
    nc = connect({ servers: natsUrl, name: 'swarm-transport' });
    await nc.connected;
    js = nc.jetstream();
  }

  return {
    kind: 'nats',
    async receive({ limit = 5, visibilityMs = 60_000 }) {
      await ensure();
      const msgs = [];
      for await (const m of js.pull(stream, consumer, { batch: limit, pending: limit, expiry: visibilityMs })) {
        const d = JSON.parse(m.data);
        inflight.set(d.taskId, { messageId: d.taskId, data: d });
        msgs.push({
          messageId: d.taskId, taskId: d.taskId, title: d.title, kind: d.kind,
          payload: d.payload, attempts: 1,
        });
      }
      return msgs;
    },
    async ack(messageId) {
      const m = inflight.get(messageId);
      if (m) { m.data.ack(); inflight.delete(messageId); }
    },
    async fail(messageId, error) {
      const m = inflight.get(messageId);
      if (m) { m.data.nack(); inflight.delete(messageId); }
    },
    async heartbeat(nodeId, meta) { /* POST /api/nodes */ },
  };
}
```

---

*Appendix A sketches the interface shape; full implementations live in PRs for
P1 (workflow), P2 (store.nats.js + transport.nats.js + docker-compose.yml).*
