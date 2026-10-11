# INTERFACE.md — frozen module contract (v1)

> **Status: FROZEN.** Every module below is implemented against this file. Do not
> change a signature to make an implementation easier; ask the lead first, because
> three workstreams are coding against it in parallel.
>
> Scope of this file: the *internal* contract of `money-app`. It is deliberately
> silent about Stripe credentials, deployment, and legal/tax reality — see
> `docs/BOUNDARY.md`.

## 1. What this app is

**Product: Swarm Toll — a metered billing gateway in front of the swarm.**

An existing swarm (`../swarm`, `../vercel-node`) accepts tasks and runs them for
free. Swarm Toll puts a **price** in front of that: a customer gets an API key,
every task costs credits, credits come from a subscription or a pre-paid pack, and
money is collected through Stripe Checkout. The app's job is to be *correct about
money*: never charge for work that failed, never double-charge a retried request,
never let a balance go negative, and let a customer audit every credit charged.

Three revenue paths, in order of realism:

1. **Subscriptions** (recurring, includes a monthly credit grant).
2. **Pre-paid credit packs** (one-time payment, no subscription).
3. **Overage** on metered plans (usage beyond the included grant).

## 2. Units and money rules (non-negotiable)

- The unit of account is the **credit**. Credits are integers. Never floats.
- **1 credit ≈ $0.02 retail** (`CREDIT_CENTS = 2`). Money is stored in **integer
  cents** everywhere. No floating-point money, ever.
- **Charge on success, refund on failure.** A task reserves credits; the debit is
  captured only when the task completes, and the reservation is released when it fails.
- **Idempotency is mandatory** on anything a retried request could duplicate:
  ledger appends, webhook handling, and task submission.
- Ledger entries are **append-only**. Never mutate or delete an entry; append a
  compensating entry (`refund`, `adjustment`) instead.
- Invariants (asserted in tests): for every customer `balance = Σ credits` of that
  customer's entries, and `balance >= 0`.

## 3. Module map and ownership

| File | Owner | Depends on |
|---|---|---|
| `lib/pricing.js` | ledger-core | — |
| `lib/ledger.js` | ledger-core | — |
| `lib/meter.js` | ledger-core | pricing, ledger |
| `lib/store.js` | auth-billing | — |
| `lib/apikeys.js` | auth-billing | store |
| `lib/billing.js` | auth-billing | pricing, ledger |
| `lib/http.js` | api-web | — |
| `lib/queue.js` | api-web | pricing |
| `lib/handlers.js` | api-web | — |
| `lib/worker.js` | api-web | ledger, meter, pricing, queue, handlers |
| `lib/app.js` | api-web | all of the above |
| `api/*.js` | api-web | lib/app.js |
| `bin/toll.mjs` | api-web | lib/app.js |
| `web/*.html` | api-web | `GET /api/pricing` |

Common conventions for all modules:

- ESM only (`import`/`export`), `node:` builtins where needed, **zero npm dependencies**.
- Every factory takes an injectable `clock: () => Date` (default `() => new Date()`),
  so tests are deterministic. Never call `Date.now()` in module logic.
- Every stateful factory supports `toJSON()` / `load(snapshot)`; the KV `store` is
  only used to persist those snapshots.
- Throw typed errors carrying a `code` string; HTTP maps `code → status` (§3.7).
- No module reads `process.env` except `lib/billing.js` and `lib/app.js`.

---

### 3.1 `lib/pricing.js`

Pure data + pure functions. Single source of truth for every price in the product;
the landing page reads it over HTTP rather than duplicating numbers.

```js
export const CREDIT_CENTS = 2;                       // retail price of one credit
export const PLANS = { free, pro, scale };           // keyed by plan id
export const CREDIT_PACKS = [ pack, ... ];
export const TASK_KINDS = { echo, http_fetch, llm_step, sandbox_exec };  // -> credits
export const COST_CENTS_PER_TASK = { echo, http_fetch, llm_step, sandbox_exec };

export function planFor(planId) -> plan             // throws PricingError('unknown_plan')
export function listPlans() -> plan[]               // stable order: free, pro, scale
export function packFor(packId) -> pack             // throws PricingError('unknown_pack')
export function priceTask(kind) -> credits          // throws PricingError('unknown_kind')
export function defaultKind() -> 'echo'
export function taskCostCents(kind) -> number       // our COGS; fractional cents allowed
export function creditValueCents(credits) -> cents
export function monthlyBill({ planId, creditsUsed, cogsCents = 0 }) -> bill
export function marginOf(bill) -> { revenueCents, cogsCents, grossMarginCents, grossMarginPct }
```

Shapes:

```js
plan = {
  id: 'pro', name: 'Pro', priceCents: 4900, period: 'month',
  monthlyCredits: 3000,                 // granted on each paid invoice
  overageCentsPerCredit: 2,             // null => hard stop, no overage allowed
  maxConcurrent: 4, requestsPerMin: 120, retentionDays: 90, hardStop: false,
}
pack = { id: 'pack_1k', name: '1,000 credits', credits: 1000, priceCents: 1500, centsPerCredit: 1.5 }
bill = {
  planId, planCents, includedCredits, creditsUsed,
  overageCredits,        // max(0, creditsUsed - includedCredits)
  overageCents,          // 0 when hardStop
  totalCents,            // planCents + overageCents
  hardStop, blockedOverageCredits,    // credits that were simply refused
  cogsCents, grossMarginCents, grossMarginPct,
}
```

Pinned values (tests assert these; do not drift):

| plan | priceCents | monthlyCredits | overageCentsPerCredit | requestsPerMin | maxConcurrent |
|---|---|---|---|---|---|
| free | 0 | 100 | null (hard stop) | 10 | 1 |
| pro | 4900 | 3000 | 2 | 120 | 4 |
| scale | 39900 | 30000 | 2 | 600 | 16 |

| task kind | credits | COGS (cents/task) |
|---|---|---|
| echo | 1 | 0.01 |
| http_fetch | 2 | 0.05 |
| llm_step | 8 | 1.50 |
| sandbox_exec | 25 | 5.00 |

---

### 3.2 `lib/ledger.js`

Append-only credit ledger + the reservation (hold) mechanism. This is the money
source of truth: everything else is derived from it.

```js
export class LedgerError extends Error { constructor(message, code) }
export function makeLedger({ clock = () => new Date() } = {}) -> Ledger

ledger.append(entry) -> { entry, duplicate: boolean }
ledger.balance(customerId) -> int                  // integer credits
ledger.available(customerId) -> int                // balance - active holds
ledger.history(customerId, { limit, kind, since } = {}) -> entry[]   // newest first
ledger.entries() -> entry[]                        // ascending seq
ledger.totals() -> { granted, debited, refunded, topupCredits, consumedCredits,
                     topupCents, revenueCents, refundedCents,
                     customers: { 'cus_x': { balance, creditsIn, creditsOut } } }
ledger.assertInvariants() -> true                  // throws LedgerError on violation
ledger.toJSON() -> snapshot ; ledger.load(snapshot) -> ledger
```

**Entry** (created only via `append`):

```js
{
  id: 'le_<hex>', seq: 1, ts: '2026-10-11T00:00:00.000Z', customerId: 'cus_ab12',
  kind: 'grant'|'topup'|'debit'|'refund'|'adjustment',
  credits: 1000,            // signed int: + adds credits, - removes
  amountCents: 1500,        // money actually collected; 0 for grant/refund/adjustment
  currency: 'usd', ref: 'task_...', memo: 'human readable',
  idempotencyKey: 'stripe:evt_123' | null,
  metadata: {},
}
```

`append` rules:

- Required: `customerId`, `kind`, `credits` (finite integer; negative is legal for
  `debit`/`refund`/`adjustment`). Everything else optional.
- `kind` outside the list → `LedgerError('unknown_kind')`; non-integer credits →
  `LedgerError('bad_credits')`; missing `customerId` → `LedgerError('bad_customer')`.
- A `debit`/`refund`/`adjustment` that would push `balance < 0` →
  `LedgerError('insufficient_credits')` and **no entry is written**.
- If `idempotencyKey` was already used → return the *existing* entry with
  `duplicate: true`, writing nothing and adding no `seq`.
- `amountCents` defaults to 0 and must be a non-negative integer.

**Holds** (reserve → capture|release; not ledger entries, never touch `balance`):

```js
ledger.authorize({ customerId, credits, ref, ttlMs = 900000 }) -> hold
   // throws LedgerError('insufficient_credits') if credits > available(customerId)
ledger.capture(holdId, { amountCents = 0, memo } = {}) -> { entry, hold }
   // writes a `debit` entry of -hold.credits, idempotencyKey `hold:<holdId>`
ledger.release(holdId, { reason = 'task_failed' } = {}) -> hold     // nothing charged
ledger.holds({ customerId, state = 'held' } = {}) -> hold[]
ledger.expireHolds(now = clock()) -> hold[]        // releases expired holds
ledger.hold(holdId) -> hold                        // throws LedgerError('unknown_hold')
```

Rule: `capture`/`release` on a non-`held` hold → `LedgerError('invalid_hold_state')`.
A hold is `held → captured | released` exactly once. `authorize` is what makes a
**402 insufficient credits** possible *before* any work starts.

### 3.3 `lib/meter.js`

Turns ledger + task events into the numbers a human reads: usage, margin, MRR.
Never invents revenue that is not in the ledger.

```js
export function makeMeter({ ledger, clock = () => new Date() }) -> Meter

meter.periodKey(date = clock()) -> '2026-10'                 // UTC calendar month
meter.periodBounds(date = clock()) -> { start, end }         // ISO strings
meter.record(event) -> event
   // event = { customerId, taskId, kind, credits, outcome: 'charged'|'refunded'|'failed', ts }
meter.usage(customerId, { from, to } = {}) -> usage
meter.canAfford({ customerId, planId, credits, cogsCents = 0 }) -> afford
meter.quota({ customerId, planId, planCreditsGranted }) -> quota
meter.report({ from, to } = {}) -> report                    // whole-business view
meter.toJSON() -> snapshot ; meter.load(snapshot) -> meter
```

```js
usage = { customerId, periodStart, periodEnd, tasks, tasksByKind: {kind: n},
          creditsUsed, creditsCharged, creditsRefunded, usageCents, cogsCents,
          grossMarginCents, grossMarginPct }
afford = { allowed, available, required, shortfall,
           reason: 'ok'|'no_credits'|'spend_cap'|'hard_stop' }
report = { customers, payingCustomers, tasks, creditsUsed, mrrCents,
           usageRevenueCents, revenueCents, cogsCents, grossMarginCents,
           grossMarginPct, byPlan: { planId: { customers, mrrCents } } }
```

`canAfford` must account for **active holds** (use `ledger.available`), not just
`balance`, or two concurrent tasks will overdraft the same credits.
`reason: 'hard_stop'` when the plan has `overageCentsPerCredit === null` and the
included grant is exhausted; `'spend_cap'` when a customer `spendCapCents` would be
exceeded by the overage this task would incur.

---

### 3.4 `lib/apikeys.js`

```js
export function makeApiKeys({ store, clock = () => new Date(), pepper = 'dev-pepper' }) -> ApiKeys

apikeys.issue({ customerId, planId, label = 'default' }) -> { key, secret }
   // secret === `sk_toll_<32 chars>`; returned exactly once, never retrievable
apikeys.verify(secret) -> { ok: true, key, customerId, planId } | { ok: false, reason }
   // reason: 'malformed'|'unknown'|'revoked'|'expired'
apikeys.revoke(keyId) -> key
apikeys.list(customerId) -> key[]        // NEVER contains secret or hash
apikeys.find(keyId) -> key
apikeys.rotate(keyId) -> { key, secret } // fresh secret for the same key id, new hash
apikeys.toJSON() -> snapshot ; apikeys.load(snapshot) -> apikeys
```

Stored `key` shape:
`{ id: 'key_<hex>', customerId, planId, label, prefix: 'sk_toll_ab12', last4,
   lookup: '<hex>', hash: '<sha256 hex>', createdAt, revokedAt: null, expiresAt: null }`.

Rules: `hash = sha256(pepper + secret)`; compare with `crypto.timingSafeEqual` over
equal-length buffers (guard length first — it throws on mismatch). A wrong secret must
not be distinguishable by timing or by any message beyond the `reason` enum. `verify`
must be O(1): index by `lookup` (`sha256(secret).slice(0,16)`), never scan-and-compare.

---

### 3.5 `lib/billing.js`

Stripe integration with **zero dependencies**: raw `fetch` to the Stripe REST API and
hand-rolled webhook signature verification (the part that is fully testable offline).

```js
export class BillingError extends Error { constructor(message, code) }
export function signStripePayload({ payload, secret, timestamp }) -> header
export function makeStripeBilling({ secretKey, webhookSecret, ledger, priceIds = {},
                                    clock = () => new Date(), fetchImpl = fetch,
                                    apiBase = 'https://api.stripe.com/v1',
                                    customers = null }) -> StripeBilling

billing.configured -> boolean
billing.createCheckoutSession({ customerId, mode, planId, packId, credits, amountCents,
                                successUrl, cancelUrl, idempotencyKey })
  -> { id, url, mode, amountCents }
  // mode: 'subscription' | 'payment'
  // throws BillingError('not_configured') without secretKey; never fakes a URL
  // throws BillingError('unknown_price') when priceIds lacks the plan/pack
billing.verifySignature({ payload, header, now = clock(), toleranceSec = 300 }) -> result
  // { ok: true, timestamp } | { ok: false, reason: 'missing'|'malformed'|
  //                              'no_match'|'timestamp_out_of_tolerance' }
billing.handleEvent(event) -> { handled, duplicate, applied: [ {kind, credits, amountCents} ] }
billing.toJSON() -> snapshot ; billing.load(snapshot) -> billing
```

Webhook events handled (anything else → `{ handled: false }`, **never throws**):

| Event | Effect |
|---|---|
| `checkout.session.completed` (mode `payment`) | `topup` grant of the pack's credits; `amountCents` from the session |
| `checkout.session.completed` (mode `subscription`) | `grant` of `plan.monthlyCredits`, `amountCents: 0` (the invoice carries the money) |
| `invoice.paid` | `grant` of `plan.monthlyCredits`, `amountCents: 0`; customer → `active` |
| `invoice.payment_failed` | no credit change; customer → `past_due` |
| `charge.refunded` | `refund` entry reversing the credits; `amountCents: 0` |
| `charge.dispute.created` | `adjustment` freezing the credits (negative entry) |

Idempotency: every event is keyed `stripe:<event.id>`; a repeat returns
`duplicate: true` and appends nothing. Credit amounts must be recoverable from the
event payload **or** from metadata written at checkout time (`metadata.customerId`,
`metadata.credits`, `metadata.planId`, `metadata.packId`) — so `createCheckoutSession`
**must** stamp that metadata, or the webhook would have to guess.

`signStripePayload` implements the real scheme: signed payload is
`` `${timestamp}.${payload}` ``, HMAC-SHA256 hex, header `t=<ts>,v1=<sig>`; all `v1`
candidates compared with `timingSafeEqual`; `|now - timestamp| > toleranceSec` →
`timestamp_out_of_tolerance`.

Also export the offline test double used by api-web's e2e tests (same surface):

```js
export function makeFakeStripeGateway({ secret = 'whsec_test', clock } = {}) -> gateway
gateway.createCheckoutSession({ customerId, mode, planId, packId, credits, amountCents,
                                successUrl, cancelUrl }) -> { id, url, mode, amountCents }
gateway.pay(sessionId) -> { payload, header, event }   // signed + deliverable webhook
gateway.sign(payload) -> header
```

---

### 3.6 `lib/store.js`

Tiny durable KV, single writer, atomic writes. No database required to run the app.

```js
export function makeStore({ path = null, clock } = {}) -> Store   // path=null => memory only
store.getJSON(key, fallback = null) -> value
store.setJSON(key, value) -> value            // tmp file + rename when path is set
store.delete(key) -> boolean
store.keys(prefix = '') -> string[]
store.flush() -> void
```

Namespace keys as `<module>/<id>` (`ledger`, `apikeys`, `meter`, `customers`, `queue`,

---

### 3.7 `lib/http.js` + `lib/app.js` — the HTTP contract

`lib/http.js` is a dependency-free router usable both as a Vercel function
(`(req, res)` Node handler) and over `node:http` (tests + `bin/toll.mjs serve`).

```js
export function createRouter() -> router
router.get(path, handler) / router.post(path, handler) / router.delete(path, handler)
router.handle({ method, path, query, headers, rawBody, apiKey }) -> { status, body, headers }
```

`createApp(deps)` returns `{ handler, store, ledger, apikeys, meter, billing, pricing,
queue, worker, customers }`. `handler(req, res)` reads the **raw body bytes before
parsing** (webhook HMACs need the exact bytes), dispatches, and sends JSON.

**Endpoints** (frozen). Errors are always `{ error: { code, message, hint? } }`.
Credits and cents are integers in every response.

| Method + path | Auth | Success | Notes |
|---|---|---|---|
| `GET /api/health` | none | `200 {ok, version, ts, stripeConfigured}` | liveness |
| `GET /api/pricing` | none | `200 {creditCents, plans, packs, taskKinds}` | from `pricing.js` |
| `POST /api/keys` | admin token | `201 { customer, key: { secret, ... } }` | body `{email, planId}`; creates/reuses customer by email; `secret` shown once |
| `GET /api/keys` | api key | `200 { keys: [...] }` | own keys, no secrets |
| `DELETE /api/keys/:id` | api key | `200 { key }` | revoke own key |
| `POST /api/tasks` | api key | `202 { task, balance, available }` | body `{kind, input}`; reserves credits, enqueues |
| `GET /api/tasks/:id` | api key | `200 { task }` | own tasks only |
| `POST /api/tasks/:id/cancel` | api key | `200 { task }` | releases the hold if still queued |
| `GET /api/usage` | api key | `200 { usage, quota }` | current period |
| `GET /api/ledger` | api key | `200 { entries, balance, totals }` | customer-auditable |
| `POST /api/billing/checkout` | api key | `200 { checkout }` | body `{mode, planId\|packId, successUrl, cancelUrl}`; `503 not_configured` without Stripe keys |
| `POST /api/webhooks/stripe` | signature | `200 { handled, duplicate, applied }` | `400 bad_signature` on a bad HMAC |

Status mapping by error `code`: `unauthorized`/`bad_api_key`→401, `insufficient_credits`→402,
`forbidden`→403, `not_found`→404, `bad_request`/`unknown_kind`/`unknown_plan`/`bad_signature`→400,
`rate_limited`→429 (+`Retry-After`), `conflict`/`invalid_hold_state`→409, `not_configured`→503,
anything else→500 (message scrubbed; full error logged server-side).

**Auth:** `Authorization: Bearer sk_toll_...` **or** `x-api-key: sk_toll_...`. Missing or
garbage → 401 with a `hint` pointing at `POST /api/keys`. Rate limit per key:
`plan.requestsPerMin` over a sliding 60 s window (in-memory); over the limit → 429 with
`Retry-After: <seconds>`.

**Task lifecycle** (`POST /api/tasks` → worker):

1. `kind = body.kind ?? defaultKind()`; `credits = priceTask(kind)`.
2. `meter.canAfford(...)`; if not allowed → `402 insufficient_credits` with
   `{available, required, shortfall, reason, upgradeUrl}`. **No hold, no task row.**
3. `ledger.authorize({customerId, credits, ref: taskId})`, then enqueue
   `{id, customerId, keyId, kind, input, credits, state: 'queued', createdAt}`.
4. The worker claims, runs `handlers.run(kind, input, ctx)`, then:
   - success → `ledger.capture(holdId)` → task `state: 'charged'` + `result`;
   - failure → `ledger.release(holdId, {reason})` → task `state: 'failed'`, `charged: false`;
   - crash / lease expiry → reclaim, or after `attempts > maxAttempts` release the hold
     (`state: 'failed'`, `charged: false`). **A failed task never charges.**
5. `meter.record(...)` on every terminal transition, so usage reflects reality.

`lib/handlers.js` exports `run(kind, input, ctx) -> { result }` (throws on failure):
`echo` (offline, free), `http_fetch` (real `fetch`, `http`/`https` only, timeout + size
cap), `llm_step` (**requires** `OPENAI_API_KEY`), `sandbox_exec` (requires an executor
config). Unconfigured kinds must **throw**, never silently no-op — the refund path is
the behaviour we most want exercised.

---

## 4. Non-goals (v1)

- No web framework, no ORM, no npm dependencies (the Postgres schema ships as SQL only).
- No crypto, no ads, no "AI trader", no growth loop. See `docs/BOUNDARY.md`.
- No sharding, no broker, no multi-region.
- No PII beyond an email address; card data never touches this code (Stripe-hosted Checkout only).

## 5. Definition of done for v1

1. `cd money-app && npm test` — all tests green under `node --test`, no network required.
2. `test/e2e.test.js` proves the whole loop over real HTTP: mint key → buy pack →
   submit task → charged on success → refunded on failure → usage and ledger agree →
   402 when credits run out.
3. `ledger.assertInvariants()` passes after the e2e run.
4. `node bin/toll.mjs report` prints revenue / COGS / margin from the ledger alone.
5. `README.md` + `docs/BOUNDARY.md` state plainly what is proven and what is not.

`webhook_events`). Writes must be whole-file atomic (tmp + `renameSync`) so a torn-down
sandbox never leaves half-written JSON. **Never store an API-key secret.**


---
