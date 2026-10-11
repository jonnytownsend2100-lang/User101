# Swarm Toll

**A metered billing gateway in front of the swarm.** Customers get an API key, every task
costs credits, credits come from a subscription or a pre-paid pack, and money is collected
through Stripe Checkout. Zero npm dependencies, zero framework, runs on a JSON file.

```bash
cd money-app
npm test                       # ~100 tests, no network, no database
node bin/toll.mjs report       # what the business actually earned: $0.00 on a fresh install
```

That last line is the point of this repo. **Read [`docs/BOUNDARY.md`](docs/BOUNDARY.md)
first** — it is the honest answer to "an app to generate money": software can charge
correctly, it cannot create demand, and this app reports $0.00 until a real payment lands.

## Why this exists

The repo already contains a swarm (`../swarm`, `../vercel-node`) that executes tasks for
free. Free work is a demo; paid work is a business. The gap between them is not
"an AI feature" — it is **money correctness**:

| Problem | Answer in this repo |
|---|---|
| What does a task cost? | `lib/pricing.js` — credits per task kind, in one file, with tests pinning the numbers |
| How do I stop someone using 10,000 tasks for free? | Reserve credits *before* the work starts (`ledger.authorize`), `402` when they run out |
| What if the task fails? | **Refund.** `capture` on success, `release` on failure. A failed task never charges |
| What if the request/webhook is retried? | Idempotency keys on ledger entries and webhook events — no double-charge, ever |
| How does money arrive? | Stripe Checkout (hosted) → signed webhook → credits granted, idempotently |
| How do I prove what I charged? | Append-only ledger + `GET /api/ledger`, auditable by the customer |

## Architecture

```
      POST /api/keys ─┐
                      │  admin token
   customer ──►  lib/app.js (router)  ──► lib/apikeys.js   hashed keys, timing-safe verify
                      │                  lib/meter.js     usage, quota, MRR, margin
                      │                  lib/ledger.js    append-only credits + holds  ◄── source of truth
                      │                  lib/pricing.js   every price, in one place
                      │                  lib/queue.js     task queue (claim / complete / fail)
                      ▼
   POST /api/tasks ──► authorize(credits) ──► queue ──► lib/worker.js ──► lib/handlers.js
                      │                                     │
                      └── 402 if unaffordable               ├─ success → ledger.capture  (charged)
                                                            └─ failure → ledger.release  (refunded)

   Stripe ──► POST /api/webhooks/stripe ──► verify HMAC ──► lib/billing.js ──► ledger grant/topup/refund
```

Money path invariants, all asserted in tests:

- Credits and cents are **integers**. No floating-point money.
- Ledger entries are **append-only**; corrections are compensating entries.
- A balance can never go negative — `ledger.assertInvariants()` fails the suite if it does.
- The only thing that grants credits is a **verified Stripe event** (or an explicit admin CLI call).

## Pricing (from `lib/pricing.js`)

One credit ≈ **$0.02**. Task prices: `echo` 1, `http_fetch` 2, `llm_step` 8, `sandbox_exec` 25 credits.

| Plan | Price | Included | Overage | Rate limit |
|---|---|---|---|---|
| Free | $0 | 100 credits (**hard stop**) | — | 10 req/min, 1 concurrent |
| Pro | $49/mo | 3,000 credits | $0.02/credit | 120 req/min, 4 concurrent |
| Scale | $399/mo | 30,000 credits | $0.02/credit | 600 req/min, 16 concurrent |

Pre-paid packs: 1,000 credits **$15** · 10,000 credits **$120**. The web pages read this
list from `GET /api/pricing`, so marketing copy cannot drift from what the API charges.
Margins, break-even and the assumptions behind them: [`docs/UNIT_ECONOMICS.md`](docs/UNIT_ECONOMICS.md).

## Run it locally

```bash
cd money-app
export TOLL_ADMIN_TOKEN=dev-admin            # protects POST /api/keys
export TOLL_DATA=./data/toll.json            # durable JSON state (omit for in-memory)
node bin/toll.mjs serve                      # http://localhost:8787  (serves web/ too)
```

```bash
# 1. mint a key (admin)
curl -s localhost:8787/api/keys -X POST \
  -H "x-admin-token: dev-admin" -H 'content-type: application/json' \
  -d '{"email":"me@example.com","planId":"pro"}'
# => { "customer": {...}, "key": { "secret": "sk_toll_...", ... } }   # shown once, never again

# 2. add credits without Stripe (dev only — in production this comes from a verified webhook)
node bin/toll.mjs topup --customer cus_xxx --credits 500 --memo "dev topup"

# 3. run a task (charged on success only)
curl -s localhost:8787/api/tasks -X POST \
  -H "authorization: Bearer sk_toll_..." -H 'content-type: application/json' \
  -d '{"kind":"echo","input":{"hello":"world"}}'

# 4. audit the money
curl -s localhost:8787/api/ledger -H "authorization: Bearer sk_toll_..."   # every credit, in order
curl -s localhost:8787/api/usage  -H "authorization: Bearer sk_toll_..."   # period usage + quota
node bin/toll.mjs report                                                    # business view
```

Failures are the interesting case: a task whose handler throws ends `failed` with
`charged: false` and its reserved credits back in the balance. Try it with
`llm_step` (needs `OPENAI_API_KEY`; without it the handler throws, by design).

## CLI

| Command | What it does |
|---|---|
| `toll serve [--port 8787]` | run the API + static pages |
| `toll init` | create the data file and print config state |
| `toll issue-key --email … --plan pro` | mint a key (prints the secret once) |
| `toll topup --customer … --credits N` | admin credit grant (dev/testing) |
| `toll usage --customer …` | usage + quota for a customer |
| `toll report` | **revenue, COGS, margin from the ledger alone** — $0.00 until real payments land |
| `toll sim --customers 200 --tasks 50` | modelled revenue/margin over a synthetic population (clearly labelled as a model) |
| `toll worker [--once]` | drain the task queue (charged on success, refunded on failure) |


## Deploy (Vercel control plane + Stripe)

```bash
cd money-app
vercel env add TOLL_ADMIN_TOKEN     # long random string; protects key minting
vercel env add TOLL_PEPPER          # long random string; API-key hashing pepper
vercel env add STRIPE_SECRET_KEY    # sk_live_… / sk_test_… (test mode first)
vercel env add STRIPE_WEBHOOK_SECRET# whsec_… from the endpoint you create below
vercel env add STRIPE_PRICE_IDS     # JSON: {"pro":"price_…","scale":"price_…","pack_1k":"price_…","pack_10k":"price_…"}
vercel --prod
```

Then in the Stripe dashboard add a webhook endpoint pointing at
`https://<your-domain>/api/webhooks/stripe` for `checkout.session.completed`,
`invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`.

Notes that will bite you otherwise:

- **`TOLL_DATA` is not usable on Vercel** — the filesystem is ephemeral and per-invocation.
  Deploying the app there without `DATABASE_URL` gives you a memory store that loses every
  ledger entry between requests. **Do not take real payments on that configuration.** The
  Postgres schema in `db/schema.sql` is the intended production store and is *not wired up*
  (see below); for anything real, run this on a host with a persistent volume until it is.
- Without `STRIPE_SECRET_KEY`, `POST /api/billing/checkout` returns `503 not_configured`
  with a hint. It never invents a checkout URL.
- Prices must exist as Stripe Price objects; the app references them by id and never creates
  them on the fly.

## Layout

```
lib/pricing.js    every price and cost, in one file          lib/http.js     tiny router (Vercel + node:http)
lib/ledger.js     append-only credits, holds, invariants     lib/queue.js    task queue
lib/meter.js      usage, quota, MRR, margin                  lib/worker.js   claim → run → capture|release
lib/apikeys.js    hashed keys, timing-safe verify            lib/handlers.js the actual work (echo/http_fetch/llm_step/sandbox_exec)
lib/billing.js    Stripe Checkout + webhook HMAC             lib/app.js      HTTP contract (§3.7 of INTERFACE.md)
lib/store.js      atomic JSON KV (dev)                       api/*.js        Vercel wrappers
db/schema.sql     Postgres DDL (not yet wired up)            bin/toll.mjs    CLI
web/index.html    landing + pricing (prices fetched)         web/dashboard.html  key + usage + ledger view
docs/INTERFACE.md       frozen module contract               docs/BOUNDARY.md       what this can/cannot do
docs/UNIT_ECONOMICS.md  margins and break-even math          test/*.test.js         ~100 tests, offline
```

## Honest status

**Verified in this sandbox:** the money math and the whole HTTP loop — key minting, a
simulated pack purchase through a signed webhook, a task charged on success, a task
refunded on failure, `402` at zero credits, idempotent webhook redelivery, tampered
signature rejection, rate limiting, ownership isolation, and `ledger.assertInvariants()`
passing afterwards. No network, no database, no Stripe account needed to reproduce.

**Not verified — do not assume:** no live Stripe API call has ever been made; no real
payment, refund or dispute has been processed; `db/schema.sql` has never been executed
against Postgres; nothing is deployed; the JSON store is single-writer (two instances
sharing one file will corrupt it); there is no tax handling, no dunning, no admin UI, and
no auth beyond API keys. The full list is in [`docs/BOUNDARY.md`](docs/BOUNDARY.md) §3.

**The bottom line:** this app can charge correctly and prove it did. It cannot make anyone
want to buy, and `toll report` will print `$0.00` until a real customer pays.

