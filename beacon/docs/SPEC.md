# Beacon — product spec

**One line.** Crawl any URL, get a scored, prioritized, white-label report on how
findable and citable it is by search engines **and AI assistants** — the report
agencies hand to prospects to win the work.

## Who pays, and why

| Segment | Pain | What they pay for |
|---|---|---|
| Marketing / SEO agencies | Prospecting is manual; audits take hours | White-label lead-magnet reports at volume |
| Freelance SEO / web consultants | Can't compete with Ahrefs/Semrush pricing | A $49 tool that looks like a $500 deliverable |
| SaaS / e-commerce marketers | Blindsided by AI answers replacing clicks | Ongoing "AI visibility" monitoring |

The buyer's ROI is immediate and legible: *one* converted prospect pays for the
subscription for a year. That is the whole sales pitch.

## What makes it not-a-wrapper

The engine is a deterministic analyzer over real fetched bytes. No LLM in the
scoring path. Every score is reproducible and explainable — agencies will not
ship an audit where the number changes on a re-run.

Seven analyzers, ~60 weighted checks:

1. **technical** — title/meta lengths, single H1, heading order, canonical, lang,
   viewport, robots meta, charset, favicon, HTTPS.
2. **content** — word count, Flesch reading ease, question density, paragraph
   structure, thin-content flag.
3. **structuredData** — JSON-LD validity + schema types, OpenGraph, Twitter card,
   microdata.
4. **aiVisibility** — `llms.txt`, AI-crawler rules in `robots.txt`
   (GPTBot/ClaudeBot/PerplexityBot/CCBot/Google-Extended), semantic landmarks,
   extractable prose, E-E-A-T signals, outbound authoritative citations.
5. **security** — HSTS, CSP, XCTO, frame policy, Referrer-Policy, mixed content,
   server banner leakage.
6. **performance** — HTML weight, render-blocking resources, image dimension/lazy
   hygiene, third-party script count, preconnect/preload hints.
7. **accessibility** — alt coverage, form labels, landmarks, skip link, link-text
   quality, button labelling.

## Outputs

- **Score**: 0–100 overall + letter grade, per-category scores, every check
  carrying `id, category, weight, status, evidence, fix`.
- **Action plan**: failures ranked by *impact ÷ effort*, split into **Quick wins**
  and **Big swings**. This is the part clients actually read.
- **Report**: self-contained HTML (white-label, inline CSS, no external assets),
  JSON, and Markdown.

## Monetization

- **Free** — 3 audits/mo, Beacon branding on the report.
- **Pro — $49/mo** — 100 audits/mo, white-label, JSON/HTML export, API key.
- **Agency — $149/mo** — 1,000 audits/mo, client workspaces, embeddable audit
  widget, webhooks.
- **Self-host license — $499/yr** — for agencies who must keep client data in
  their own cloud.

Billing is Stripe-shaped: a checkout session + a signature-verified webhook.
Dev mode (no Stripe keys) grants plans locally so the product runs end-to-end
out of the box.

## Non-goals (deliberate)

- Not a crawler fleet for whole sites (single-page + a few key paths today).
- Not a rank tracker (needs SERP data we won't scrape).
- Not a link index (needs a crawl corpus we don't have).
- No black-hat "AI spam" features. The ToS/quality boundary is explicit in
  `docs/MONETIZATION.md`.

## Honest limits

- **This does not create money by itself.** It is a product; revenue = price ×
  distribution. `docs/MONETIZATION.md` is the distribution plan, not a promise.
- Scores are heuristics. They are stable and explainable, not authoritative.
- Single-page audits only; no site-wide crawl graph yet.
- The Postgres/multi-tenant path is file-backed by default; swap in a real DB
  before real traffic (documented in `docs/ARCHITECTURE.md`).
