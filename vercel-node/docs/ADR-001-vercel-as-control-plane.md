# ADR-001: Vercel as control plane, not as the workforce

**Status:** accepted · **Date:** 2026-10-10 · **Supersedes:** the "Vercel swarm node"
proposal in `vercel-node/README.md`

## Context

We wanted a persistent compute node for an agent/worker swarm. Three substrates
were considered: an ephemeral Cline sandbox, a git-backed node (`../swarm`), and
Vercel.

The git node worked and survived teardown, but had three defects: no scheduler,
git as a slow message bus, and concurrent runs corrupting a shared worktree.

Vercel appeared to supply exactly those missing pieces — and it does. But its
own documentation changes the conclusion:

- **Hard caps.** Proxied request timeout is **120s on every plan including
  Enterprise**. Function duration is **300s max on Hobby**; 800s (1800s beta)
  on Pro. Build time is capped at **45 minutes on all plans**. Hobby allows
  **1 concurrent deployment**.
- **Spend controls are opt-in and partial.** Spend Management is Pro/Enterprise
  only, and *"setting a spend amount does not stop usage on its own"* — pausing
  is a separate switch. It excludes seats, Marketplace integrations, and add-ons.
  Hobby instead **hard-stops at its caps**, turning overspend into an outage.
- **Fair use is discretionary and broad.** The "never fair use" list includes
  proxies/VPNs, scrapers, load testing without authorization, and pentesting,
  applied *"across plans and usage-based resources."* A high-frequency,
  machine-shaped worker fleet is structurally indistinguishable from that list.
- **The agentic primitives are beta.** Queues, Sandbox, Container Registry,
  Services, Key Management, and WebSockets are all beta — no SLA.

## Decision

**Use Vercel as the control plane. Run the compute nodes off Vercel.**

- **On Vercel:** scheduling (Cron), the message layer (Queues), orchestration
  (Workflows for anything that may exceed the duration cap), and the HTTP task
  inbox. This is what Vercel is genuinely excellent at.
- **Off Vercel:** the long-lived worker processes, via **Poll Mode**, which the
  docs explicitly support: *"publish messages from your Vercel app and process
  them wherever your infrastructure runs."* That is the sandbox, a VPS, on-prem,
  or another cloud — anywhere we control limits, cost, and traffic shape.
- **Long tasks** become Workflows rather than long function invocations.
- **No generic-compute framing.** Handlers do real application work (DB/API/
  agent steps), which is explicitly fair use. We do not use Vercel as a proxy,
  relay, scraper, or media host. Hobby is non-commercial only.

## Consequences

**Good**
- The three git-node defects are solved without owning a scheduler or broker.
- Compute cost and blast radius move to infrastructure we control.
- Vercel's ToS exposure is bounded to orchestration, which is the shape they
  invite.
- The node is transport-agnostic: `HttpPollTransport` today, Vercel Queues or
  anything else tomorrow, without touching the daemon.

**Bad**
- Two systems to operate instead of one. A deployed Vercel project plus at least
  one long-lived worker host.
- Poll Mode's beta SDK surface may move; hence the injected-client adapter and
  loud failure rather than silent no-op.
- The git node (`../swarm`) is still the better choice for work needing a real
  filesystem checkout.

## Evidence

44 tests pass (`npm test`), including three **real-HTTP end-to-end** tests that
stand up a server, run the node's poll/execute/ack loop over the wire, and verify
two nodes sharing one queue process six tasks exactly once.

## Open questions

- **Cron minimum interval per plan is unverified.** We did not confirm exact
  numbers; if Hobby is daily-only, cron polling there is not viable. Verify
  before relying on fast polling.
- **The Postgres path is untested here** — no Postgres in the sandbox. The
  `SKIP LOCKED` statement is the canonical pattern but is not exercised by CI.
- **`PollingQueueClient` method names are unverified** — the docs fetch was
  truncated before the code samples. The adapter resolves several plausible
  names and throws if none match, so this fails visibly rather than silently.
