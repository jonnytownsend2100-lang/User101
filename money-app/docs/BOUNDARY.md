# BOUNDARY.md — what this app can and cannot do

> Written before the code was finished, on purpose. The framing here constrains the
> implementation, not the other way round.

## 1. The request was "an app to generate money". Here is the honest translation.

**No app generates money.** Money moves when a human or a business decides that something
is worth paying for, and then actually pays. Software can be the thing they pay for, and
software can be the machinery that charges them correctly — that is the entire overlap
between "app" and "money".

So this repo contains the *second* thing: **Swarm Toll**, the metering and billing layer
that makes it possible to charge for swarm work. It is the cash register, not the customer.
A cash register with no shop in front of it rings up **$0.00**, and that is exactly what
`node bin/toll.mjs report` prints on a fresh install. That is not modesty — it is the
correct reading of the ledger.

The three things that must be true before a single cent arrives:

1. **Something worth paying for.** Here it is swarm task execution (the substrate in
   `../swarm` and `../vercel-node`). Whether anyone wants it is an open question this repo
   does not answer.
2. **A way to collect.** Stripe Checkout, which needs a real business, a real identity, a
   bank account, and tax handling. None of that can be created from inside a sandbox.
3. **Customers.** Distribution, positioning, trust, support. Not in this repo.

We built (2)'s plumbing and (1)'s pricing. We did not and cannot build (3).

## 2. What is genuinely proven by the tests

- Money math is integer-cents and invariant-checked: balances cannot go negative, and
  `ledger.assertInvariants()` fails if entries stop summing to balances.
- **Charge on success, refund on failure.** A task that throws is released, not charged —
  proven over real HTTP, not just in a unit test.
- **Retries cannot double-charge.** Ledger entries and webhook events are idempotently
  keyed; a redelivered Stripe event grants credits exactly once.
- **Work is refused before it is done** when credits are gone: `402 insufficient_credits`
  arrives *before* anything is enqueued.
- **Webhook signatures are verified for real** (HMAC-SHA256 over `t.payload`, constant-time
  compare, 300 s tolerance). A tampered body is rejected with `400`.
- API keys are stored only as `sha256(pepper+secret)` with a constant-time compare; the
  secret is shown once and is not recoverable from the database.
- A customer can audit every credit they were charged: `GET /api/ledger`.

## 3. What is NOT proven, and would need to be before anyone is charged

- **No live Stripe call has ever been made.** `STRIPE_SECRET_KEY` was never available in
  this sandbox. Checkout-session creation is tested only against an injected `fetchImpl`
  and an offline fake gateway. The real API could still reject our form encoding, or the
  price-id mapping could be wrong.
- **No real payment, refund, or dispute has been processed.** Webhook handling is tested
  against constructed events matching Stripe's documented shapes. Documented shapes are not
  production payloads — expect field drift on first contact.
- **The Postgres schema in `db/schema.sql` has never been executed.** No Postgres here; the
  app runs on the JSON KV store instead.
- **Nothing is deployed.** No Vercel project, no domain, no TLS, no cron.
- **The pricing is untested against a market.** See `UNIT_ECONOMICS.md` — the margins are
  arithmetic, the demand is a guess.
- **Concurrency is single-process.** The store is a single-writer JSON file and the rate
  limiter is in-memory; two instances sharing one store would corrupt it. A real deployment
  needs the Postgres path and a shared rate-limit store.
- **No tax, invoicing, dunning, proration, VAT/GST.** Stripe can do some of this; none of it
  is configured or tested here.
- **No auth beyond API keys.** No password reset, sessions, 2FA, team accounts, admin UI, or
  audit log of key creation.

## 4. Deliberate non-goals (things this app will not do)

Aligned with the "deliberate no's" in `../swarm/PLATFORMS.md` §8:

- **No scraping, no proxies, no load testing, no pentesting-for-hire.** These violate the
  acceptable-use policies of the substrates the swarm runs on, which would turn a billing
  bug into a termination notice.
- **No crypto, no tokens, no "passive income", no trading bots.** Nothing here produces
  yield; anything that claims to is either market risk or fraud.
- **No fabricated social proof.** The landing page has no testimonials, no customer logos,
  no "trusted by" strip, no invented usage counters. If it says something, the repo can
  back it up.
- **No dark patterns.** No fake scarcity, no pre-checked upsells, no "contact sales" maze
  hiding the price. Every price is served from `lib/pricing.js` over `GET /api/pricing`, so
  the marketing page cannot drift from what the API charges.
- **No silent failure on unconfigured services.** Missing Stripe keys produce an explicit
  `503 not_configured` with an actionable hint. An unconfigured `llm_step` handler throws
  and the customer is refunded. We never take money for work we did not do, and never
  pretend to have done it.
- **No selling of customer data.** No analytics pipeline, no third-party script on the
  pages, and the only PII stored is an email address.

## 5. Compliance notes for whoever deploys this

- Stripe's terms require a real business/individual identity, and a live account is subject
  to KYC. Test mode is free and needs no approval — start there.
- Selling to consumers in the EU/UK implies VAT/GST obligations; B2B still implies invoicing
  rules. This app does not compute tax; Stripe Tax or an accountant must.
- The free tier exists to be converted, not farmed. If abuse appears, the hard stop and
  per-key rate limits are the only levers here; a real deployment should add email
  verification and per-IP limits.
- Deleting a customer means deleting ledger entries, which breaks the append-only invariant
  by design. A real deployment needs a documented retention/deletion policy and a lawful
  basis for keeping financial records (usually 7 years).

## 6. The one-sentence version

This app can take money correctly and prove that it did; it cannot make anyone want to give
it any, and it will honestly report **$0.00** until someone does.

