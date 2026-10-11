# Mint

An app that generates money. Not the way the phrase usually means — this is
not a scheme, and no software can conjure demand. It is the *other* half of the
sentence made concrete: **software that takes a thing you can deliver and turns
it into collected payments, delivered licences, and a ledger you can trust.**

That half is genuinely worth building, and it is the half most people skip.

## The uncomfortable part, first

Money generation decomposes into four jobs, and this app only owns three of them:

| Job | Who does it | What Mint does |
|---|---|---|
| 1. Someone wants something you have | **you** — this is the hard, non-technical part | offers a storefront to sell it from |
| 2. Collect the payment | provider (Stripe) | builds the checkout session, verifies the webhook |
| 3. Deliver what was bought | Mint | mints an HMAC-signed license key the buyer can carry away |
| 4. Know what you actually kept | Mint | ledger: gross − fees − refunds = net, plus MRR/ARR |

If job 1 is missing, everything below is a very well-tested machine that sells
nothing. I cannot help with job 1; I can make sure jobs 2–4 are not what stops
you. That is the entire pitch, stated without decoration.

## See it work in one command

```bash
cd mint
node bin/mint.mjs demo      # boots the real app and walks all 15 steps of the funnel
node bin/mint.mjs init      # then: a persistent store + default catalog
node bin/mint.mjs serve     # storefront on http://localhost:8787
```

`demo` output, verbatim from this sandbox:

```
   1. GET / (storefront)                             200 products rendered
   2. GET /api/products                              200 3 products
   3. POST /api/checkout                             201 ord_91e8bd3578ad $29.00 (fee $0.00, net $29.00)
   4. GET /pay/:id (buyer lands here)                200 simulated checkout page
   5. POST webhook without claim token               403 mock settlement requires the order claim token
   6. POST webhook with claim token                  200 paid, license issued
   7. POST the same webhook again                    200 duplicate=true (no second license)
   8. GET /thanks (buyer collects key)               200 MINT.eyJ2IjoxLCJzdWIiOiJvcmR...
   9. POST /api/verify                               200 valid=true
  10. GET /api/metrics (owner)                       200 gross $29.00 net $29.00 mrr $29.00
  11. GET /dashboard (owner)                         200 console rendered
  12. GET /api/metrics without token                 401 unauthorized
  13. POST /api/refund                               200 refunded, license revoked
  14. POST /api/verify after refund                  402 valid=false reason=revoked
  15. GET /api/metrics after refund                  gross $29.00 refunds $29.00 net $0.00
```

Every one of those steps is asserted in `test/server.test.js`, so the demo is a
claim you can falsify, not a screenshot.

## The money path

```
buyer                     mint (this app)                        provider
  |  GET /                    |                                     |
  |-------------------------->|  product page from the catalog      |
  |  POST /api/checkout       |                                     |
  |-------------------------->|  order(pending) + fee + net         |
  |                           |------------------------------------>|  create checkout session
  |  <-- checkoutUrl ---------|                                     |
  |  pays on the provider's page (card data never touches Mint) ----->|
  |                           |  <-- webhook, signature verified ----|
  |                           |  order(paid) + license issued        |
  |  GET /thanks?order&t      |                                     |
  |-------------------------->|  returns the signed key              |
  |                           |  ledger: gross - fees - refunds      |
```

Order states: `pending → paid → refunded` (or `partially_refunded`), plus
`failed` when the provider refuses to create the session. Refunds revoke the
licence, because a refund that leaves the product working is a donation.

## The design decisions that matter

**Money is integer minor units, never floats.** `lib/money.js` converts once at
the edge. A ledger that drifts by a cent is a ledger nobody trusts.

**Net, not gross, is the headline number.** `lib/providers.js` declares each
provider's fee schedule (Stripe: 290 bps + 30¢, as published) and the ledger
subtracts it. Gross revenue is a vanity metric; `report` shows what survived.

**Licenses are signed capabilities, not database rows.**
`MINT.<base64url(payload)>.<hmac>` verifies offline with no lookup, so a buyer
can check a key inside their own product without calling you. `verifyLicense()`
never throws on hostile input.

**Webhooks are idempotent.** Providers retry. A retried delivery must not mint a
second licence or double-count revenue — `markPaid()` is a no-op on an order
that is already settled, and there is a test for exactly that.

**Underpayment is refused, not rounded.** If the provider reports less than the
order asked for, settlement fails loudly.

**The mock provider is not a payment processor.** It exists so the whole funnel
is testable offline. It is labelled as simulated in the UI, and the settlement
endpoint demands the order's claim token so nobody can POST an order id and mint
a free licence. It is the default locally; it must never be the default in
production.

**Claim tokens, not order ids, authorise reading an order back.** Order ids leak
into logs and referrers. `GET /thanks?order=…` without the token is a 403.

## Going live

```bash
export MINT_PROVIDER=stripe
export STRIPE_SECRET_KEY=sk_live_...
export STRIPE_WEBHOOK_SECRET=whsec_...        # from the endpoint you create below
export MINT_LICENSE_SECRET=$(openssl rand -hex 32)
export MINT_ADMIN_TOKEN=$(openssl rand -hex 24)
export MINT_BASE_URL=https://your-domain.example
export MINT_ALLOW_MOCK=0
node bin/mint.mjs serve
```

Then in the Stripe dashboard add a webhook endpoint pointing at
`https://your-domain.example/api/webhook/stripe` for `checkout.session.completed`
and `charge.refunded`, and paste its signing secret into
`STRIPE_WEBHOOK_SECRET`. The handler verifies `Stripe-Signature` (HMAC over
`timestamp.rawBody`, 300-second tolerance, timing-safe compare) **before** it
looks at the event, and the app never sees a card number — Stripe Checkout hosts
that page, so the PCI surface stays with Stripe.

Local end-to-end with real Stripe objects: `stripe listen --forward-to
localhost:8787/api/webhook/stripe`.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | — | storefront |
| GET | `/api/products` | — | active catalog |
| POST | `/api/checkout` | — | create order + checkout session |
| GET | `/pay/:orderId` | — | mock provider's simulated page |
| GET | `/thanks?order=&t=` | claim token | buyer collects the licence |
| GET | `/api/orders/:id?t=` | claim token | machine-readable order |
| POST | `/api/verify` | — | verify a licence key (+ revocation check) |
| POST | `/api/webhook/mock` | claim token | simulated settlement |
| POST | `/api/webhook/stripe` | signature | real settlement |
| GET | `/dashboard` | admin | owner console |
| GET | `/api/metrics` | admin | ledger as JSON |
| GET | `/api/orders` | admin | recent orders |
| POST | `/api/refund` | admin | refund + revoke |
| GET | `/healthz` | — | liveness |

Admin auth is `Authorization: Bearer <MINT_ADMIN_TOKEN>` or `?token=`. If the
token is unset the app generates one, stores it `0600` under the data directory,
and prints it at boot. Mutating public routes are rate-limited per IP
(40/minute, fixed window, per process).

## CLI

```
node bin/mint.mjs demo                        boot the app and walk the whole funnel
node bin/mint.mjs init | seed | products      catalog setup
node bin/mint.mjs product add --name X --price 29 [--interval month] [--pwyw --min 5]
node bin/mint.mjs serve [--port 8787]
node bin/mint.mjs simulate [--email you@x]    create + settle one order
node bin/mint.mjs report [--days 30]          net revenue after fees and refunds
node bin/mint.mjs keygen [--days 365]         mint a key by hand
node bin/mint.mjs verify <key>                verify offline
```

## Test

```bash
npm test        # 56 tests, zero dependencies, all passing
```

Coverage: money arithmetic and formatting, licence sign/verify/tamper/expiry,
the full order lifecycle (idempotency, underpayment, refund revocation, PWYW
floor, quantity caps, provider failure), ledger maths (net, MRR normalisation,
refunded subscriptions, daily series, by-product), Stripe webhook signature
verification (wrong secret, replay window, tampered body), and HTTP integration
(auth, claim tokens, rate limiting, 4xx behaviour).

## Honest limits

- **This cannot create demand.** Job 1 in the table above is yours. Everything
  here is downstream of someone wanting the thing.
- **The Stripe path has never touched live Stripe.** Signature verification and
  session construction are tested against a fake transport, and the parameter
  names come from the API docs; the first real `sk_live_` call is yours to make.
  I have no Stripe credentials in this sandbox.
- **The store is a JSON file.** Fine for a single process and a small catalog;
  it is not a database. Two concurrent writers, or a serverless deploy with
  ephemeral disk, will lose data. Move to Postgres/SQLite before real traffic.
- **Recurring revenue is under-counted.** Stripe runs the subscription; this app
  only records the initial checkout order. Renewals, upgrades and failed
  payments never come back as new orders, so MRR here is "new subscription
  revenue", not a billing-system figure. A `invoice.paid` handler is the fix and
  is not written.
- **Revocation needs the store.** A refunded key still passes offline signature
  checks — the signature is valid, the entitlement is not. `/api/verify`
  consults the store and returns 402 `revoked`; a purely offline verifier cannot
  know. Choose per deployment.
- **No tax, VAT, invoicing or receipts.** Stripe Tax exists; wiring it is not done.
- **No dunning, no email.** Nothing is sent to the buyer; the claim link is the
  only copy of the licence. Add an email step before selling to strangers.
- **Rate limiting is per process** and in memory, so it resets on restart and does
  not hold across instances. A real deployment wants this at the edge.
- **Prices in the seeded catalog are placeholders**, not advice about what your
  work is worth. `priceAdvice()` will tell you the arithmetic of a bad price,
  not the right one.

## Layout

```
lib/money.js       integer minor units, formatting, provider fees
lib/store.js       atomic JSON store + append-only event log
lib/catalog.js     product validation, seed catalog
lib/providers.js   mock + stripe: checkout, webhook parsing, signature checks
lib/checkout.js    order lifecycle: create -> pay -> refund, licence issuance
lib/license.js     HMAC-signed keys, offline verification
lib/ledger.js      net revenue, MRR/ARR, daily series, price advice
lib/pages.js       server-rendered storefront, simulated checkout, console
lib/server.js      HTTP routes, admin auth, rate limiting, webhook endpoints
bin/mint.mjs       CLI (init, seed, serve, demo, simulate, report, keygen, verify)
test/              56 tests, no dependencies
```

Zero runtime dependencies: `node:crypto`, `node:http`, `node:fs`. Node >= 20.
