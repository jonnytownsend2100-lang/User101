# Money Engine

**An app for generating money.** It cannot do that, and no app can — so this one does the
next most useful thing: it tells you whether a way of making money actually works
arithmetically, how many customers it takes, how long until you have your money back, and
which single change pays best.

You describe a business. It does the arithmetic. You decide.

```
$ node cli.mjs --playbook micro-saas --target 3000

  WHERE IT LANDS
    Monthly net at month 24                     $2,278
    Trailing-12-month net                      $19,570
    Net margin at the end                        51.4%
    Effective rate                           $25.09/hr  (15 h/week)

  WHAT IT TAKES
    Units to break even                        14.7/mo
    Contribution per unit                       $20.45
    First profitable month                           2
    Payback on startup capital                       3  (deepest: -$714)

  LEVERS, RANKED BY ANNUAL IMPACT (~10% move each)
     1. Grow 10% faster                    $4,612  ████████████████
     2. Raise price 10%                    $2,410  ████████
     3. Acquire 10% more customers         $2,216  ████████
     4. Reduce churn 10%                   $2,199  ████████
```

## Quick start

No dependencies, no build step, no account. Node 20+.

```bash
cd money-engine

node --test test/*.test.mjs     # 78 tests
node server.mjs                 # then open http://127.0.0.1:4173
node cli.mjs --help             # same model, in the terminal
```

## What it computes

| Output | Why it matters |
|---|---|
| Monthly and trailing-12-month net profit | the number you actually live on |
| Break-even volume and revenue | the floor you have to clear before anything is yours |
| Contribution per unit | the profit one more sale adds |
| First profitable month, payback month | how long you are funding it out of pocket |
| Peak cash required | the real cost of finding out |
| Effective hourly rate | what the hours are worth, net, after everything |
| **Levers, ranked by annual impact** | the order to work in, for the same effort |
| Goal-seek | customers, or price, needed to clear a target |
| Warnings | churn that cancels growth, negative contribution, work that cannot pay |

The lever ranking is the point. "Grow 10% faster" and "raise prices 10%" cost very
different amounts of effort and pay very different amounts — most people guess the order
wrong, and this shows them the order their own numbers imply.

## The model

One month, in full:

```
revenue           = units × price
gross profit      = revenue − revenue × delivery%
acquisition cost  = new units × cost per customer
operating profit  = gross profit − fixed costs − acquisition cost
tax               = operating profit > 0 ? operating profit × tax% : 0
net profit        = operating profit − tax
```

Recurring models grow the base by `growth% − churn%` per month, but pay acquisition
cost on `growth% + churn%`:

```
contribution per unit = price × (1 − delivery%)
                        − acquisition cost × (growth% + churn%)

break-even units      = fixed costs ÷ contribution per unit
```

That churn term is deliberate and it is the part most models get wrong. To grow 10% a month
while losing 6%, you must acquire **16%** of your base every month — you replace the
leavers before you add anyone. Models that charge acquisition only on net growth make
subscription businesses look far more profitable than they are, and that error is what
makes people quit jobs they should have kept.

`growth`, `churn`, and `delivery%` are held constant. Real curves bend, usually downward.
Treat the output as an upper bound on the plausible, not a forecast.

## The interface

`http://127.0.0.1:4173` — a single page, no framework:

- **Modeller** (left): every input, with a playbook selector that loads realistic starting numbers.
- **Headline cards**: profit, effective rate, break-even, payback, cash you must front.
- **Cumulative profit chart**: hand-drawn inline SVG. Bars are monthly net, the line is the
  running total, and the dashed line is your setup cost. Where the line crosses zero is the
  month you got your money back.
- **Levers**, ranked, with the exact input change each bar assumes.
- **Goal-seek**: what it takes to clear your target.
- **Playbook library**: nine ways people actually make money, each with its main risk and why
  most people fail at it.

## Playbooks

Nine archetypes, each with honest ranges, a named main risk, and a three-step start. The
ranges are wide on purpose — the spread is the finding, and for several of these the median
new entrant earns nothing.

| Playbook | Startup | Realistic net | Honest risk |
|---|---|---|---|
| Freelance skill-for-hire | $0–500 | $500–6,000/mo | income stops when you stop |
| Productized service | $0–2,000 | $1,000–10,000/mo | delivery is still your time |
| Micro-SaaS | $0–5,000 | $0–15,000/mo | distribution, not the build; most never reach $1k MRR |
| Digital products | $0–500 | $0–5,000/mo | without an audience, sales are ~zero |
| Local service business | $1,000–15,000 | $1,500–8,000/mo | ceiling is your body until you hire |
| Ecommerce (POD/dropship) | $200–3,000 | $0–4,000/mo | ad costs outrun your price |
| Coaching / tutoring | $0–1,000 | $800–6,000/mo | absolute time ceiling |
| Audience → sponsorship | $0–500 | $0–8,000/mo | years unpaid, no guarantee |
| Reselling / arbitrage | $200–5,000 | $200–3,000/mo | dead stock eats your capital |

## CLI

```bash
node cli.mjs                                     # default scenario
node cli.mjs --playbook local-service --target 5000
node cli.mjs --mode flow --price 150 --units 40 --var 30 --fixed 900 --hours 25
node cli.mjs --playbook micro-saas --json         # machine-readable
```

Flags: `--mode --price --units --growth --churn --var --fixed --cac --tax --startup
--hours --months --playbook --target --json`. Any flag overrides the playbook preset.

## HTTP API

Dependency-free, stdlib only, `127.0.0.1` by default.

| Route | Purpose |
|---|---|
| `GET /` | the app |
| `GET /api/playbooks` | the library |
| `GET /api/health` | liveness |
| `POST /api/simulate` | full projection, levers, warnings (`targetMonthlyNet` adds `goal`) |
| `POST /api/goal-seek` | what it takes to hit a target |
| `POST /api/export.csv` | the monthly ledger as CSV |

Bad input returns `400` with a readable message, never a `500`. Bodies are capped at 64 KB.
Static path resolution is containment-checked, so it cannot be walked out of `public/`.

## Layout

```
src/engine.mjs      the model: projection, break-even, sensitivity, goal-seek  (pure, no I/O)
src/playbooks.mjs   the nine archetypes and their presets
cli.mjs             terminal report and JSON output
server.mjs          stdlib HTTP server: static files + JSON API + CSV
public/             index.html, app.js, styles.css  (no framework, no build)
test/               engine, playbooks, server, and UI-render tests
```

All arithmetic lives in `src/engine.mjs`. The browser, the CLI, and the HTTP API call the
same functions, so they cannot disagree about a number.

## Tests

```bash
node --test test/*.test.mjs
```

78 tests, covering: unit compounding and churn replacement, tax on positive profit only,
break-even algebra (verified by feeding the break-even volume back through the model and
asserting zero operating profit), payback and startup cost, goal-seek (verified the same
way), lever ranking and ordering, warning conditions, CSV totals matching the monthly rows,
HTTP status codes for bad input, path-traversal refusal, oversized bodies, and a render
smoke test that stubs the DOM and runs the real `public/app.js` to prove the dashboard
actually produces markup.

## What this cannot tell you

- **It cannot see demand.** A perfect model of a business nobody wants is still worth zero.
- **Cash timing is ignored.** Revenue is booked when earned, not when collected. Late payers
  and chargebacks are invisible here.
- **Growth and churn are constants.** Real curves bend, usually downward.
- **It is a single stream.** No seasonality, no product mix, no hiring model.
- **Playbook ranges are other people's outcomes**, summarised, not promises about yours.

Use it to reject bad arithmetic before it costs you a year. That is where it earns its keep.

