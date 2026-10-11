# Unit economics — where the money would come from

> **Read `docs/BOUNDARY.md` first.** This file does arithmetic, not promises. Every
> number below is either (a) read straight out of `lib/pricing.js` — the single source of
> truth that the API and the landing page both serve — or (b) an **assumption labelled as
> one**. Nothing here is revenue we have collected.

## 1. The price list (from `lib/pricing.js`)

| Unit | Retail price | Our COGS | Gross margin |
|---|---|---|---|
| 1 credit | **$0.02** | $0.00106 (mix-weighted, §3) | ~95% |
| `echo` task (1 credit) | $0.02 | $0.0001 | 99.5% |
| `http_fetch` task (2 credits) | $0.04 | $0.0005 | 98.8% |
| `llm_step` task (8 credits) | $0.16 | $0.0150 | 90.6% |
| `sandbox_exec` task (25 credits) | $0.50 | $0.0500 | 90.0% |

| Plan | Price / month | Included credits | Overage | Requests/min | Concurrent |
|---|---|---|---|---|---|
| Free | $0 | 100 (hard stop) | — (never billed) | 10 | 1 |
| Pro | **$49** | 3,000 | $0.02 / credit | 120 | 4 |
| Scale | **$399** | 30,000 | $0.02 / credit | 600 | 16 |

| Pre-paid pack | Price | Credits | Effective | Margin |
|---|---|---|---|---|
| `pack_1k` | $15 | 1,000 | $0.015 / credit | 88% |
| `pack_10k` | $120 | 10,000 | $0.012 / credit | 88% |

Two deliberate choices worth defending:

- **Packs are priced below the metered overage rate** ($0.012–0.015 vs $0.02). Pre-paid
  cash up front is worth more than the 4–7 points of margin, and it caps collection risk.
- **The free plan hard-stops.** It has no overage price, so a runaway script on the free
  tier produces a `402`, never an invoice. That is the difference between a free tier and
  an unbounded liability.

## 2. Per-customer contribution (subscription plans)

Fees are Stripe's standard US card rate, **2.9% + $0.30** per successful charge. COGS is
the mix-weighted figure derived in §3.

| | Pro | Scale |
|---|---|---|
| Revenue | $49.00 | $399.00 |
| COGS (credits included, fully used) | −$3.17 | −$31.75 |
| Stripe fees | −$1.72 | −$11.87 |
| **Contribution margin** | **$44.11 (90.0%)** | **$355.38 (89.1%)** |

Caveat that matters: included credits are only COGS **if the customer actually uses
them**. Unused included credits are pure margin. I am *not* assuming breakage above —
these are the pessimistic numbers where every included credit is burned.

## 3. The mix assumption (the one real assumption in this file)

Cost per credit depends entirely on what customers run, so I fix a workload mix and say
it out loud. **Assumed mix per 100 tasks:** 70 `echo`, 20 `http_fetch`, 8 `llm_step`,
2 `sandbox_exec`.

- Credits consumed: `70×1 + 20×2 + 8×8 + 2×25 = 224`
- COGS: `70×$0.0001 + 20×$0.0005 + 8×$0.015 + 2×$0.05 = $0.2370`
- Revenue at list price: `224 × $0.02 = $4.48`
- **Blended margin: 94.7%**; blended COGS **$0.00106 per credit**

Sensitivity: if the mix shifts to 50% `sandbox_exec`, blended COGS per credit rises to
~$0.0022 and margin falls to ~89% — the plan prices still hold. Margin only breaks if a
task kind is mispriced, which is why task prices live in one file with tests pinning them.

## 4. Break-even

Fixed-cost assumption (labelled as such): Vercel Pro for the control plane + cron
**$20**, domain **$1**, database on a free tier **$0**, Stripe/email **$0** →
**≈$25 / month**.

| Break-even target | Pro customers needed | Scale customers needed |
|---|---|---|
| Cover infrastructure ($25/mo) | **1** | 1 |
| + founder time at $1,000/mo (≈5 h/wk @ $50/h) | **24** | 3 |
| + $8,000/mo take-home | **182** | 23 |

Row 1 is the only easy one, and also the least interesting: covering a $25 bill is not
"generating money". The honest headline is row 2 — **~24 Pro customers** to make this
worth a human's time, or 3 Scale customers. Everything downstream of that is a
distribution problem, not a software problem, and **this repo contains no distribution.**

## 5. What would have to be true (the funnel)

To land 24 Pro customers at a 2% free→paid conversion you need ~1,200 free signups; at 1%
you need ~2,400. Each free signup costs ~$0.11/month in COGS if it burns its full
100-credit grant — so 10,000 dormant free users would cost ~$1,060/month in COGS against
$0 revenue. That is the failure mode this pricing is built to survive (hard stop, no
overage on free, 7-day retention).

The uncomfortable column: none of this exists yet. No signups, no traffic, no channel.
`bin/toll.mjs sim` can generate 10,000 modelled customers and a beautiful report in under
a second, and it will still be **$0 collected**, because a simulation cannot pay an invoice.

## 6. What the software actually contributes

| Business problem | Solved here? |
|---|---|
| Charge the right amount, exactly once, on retries | **Yes** — idempotency keys on ledger entries and webhook events; tests assert no double-charge |
| Never charge for work that failed | **Yes** — `authorize` → `capture` on success / `release` on failure; tested end to end |
| Refuse work before doing it when credits are gone | **Yes** — `402 insufficient_credits` before the task is enqueued |
| Let a customer audit every cent | **Yes** — append-only ledger, `GET /api/ledger` |
| Collect money | **Only with a live Stripe account + business identity** — see `BOUNDARY.md` |
| Find customers and make them care | **No.** Out of scope. Nothing in this repo does this. |
| Print money | **No.** No software does. |

## 7. How to reproduce these numbers

```bash
cd money-app
node bin/toll.mjs sim --customers 200 --tasks 50 --seed 7   # modelled revenue/COGS/margin
node bin/toll.mjs report                                    # real ledger: revenue actually recorded
```

`sim` is labelled as a model everywhere it prints. `report` reads the ledger and reports
**$0** until a real webhook from a real payment lands — which is the correct behaviour,
and the reason the two commands are separate.

