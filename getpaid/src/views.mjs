/**
 * Views. Plain string templates, no framework, no build step: the dashboard is
 * one screen that answers "who owes me what, and what is this app doing about
 * it". Every interpolated value is escaped — invoice numbers, customer names
 * and emails are all attacker-influenced text.
 */
import { formatCents } from './money.mjs';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STAGE_LABEL = {
  nudge: 'nudge sent',
  reminder: 'reminded',
  firm: 'firm + late fee',
  final: 'final notice',
};

const BASE_CSS = `
  :root { color-scheme: dark; --bg:#0e1116; --panel:#161b22; --line:#2a313c; --fg:#e6edf3; --dim:#8b949e; --accent:#3fb950; --warn:#d29922; --bad:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:1040px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:26px; margin:0 0 4px; } h2 { font-size:16px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:36px 0 12px; }
  .sub { color:var(--dim); margin:0 0 28px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .k { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .card .v { font-size:24px; font-weight:600; margin-top:6px; font-variant-numeric:tabular-nums; }
  .card .n { color:var(--dim); font-size:12px; }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  th,td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; }
  th { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  tr:last-child td { border-bottom:none; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); color:var(--dim); }
  .ok { color:var(--accent); } .warn { color:var(--warn); } .bad { color:var(--bad); }
  .banner { border:1px solid var(--warn); background:#2a2213; color:#f0d69b; padding:10px 14px; border-radius:8px; margin-bottom:20px; font-size:14px; }
  .bars span { display:inline-block; height:10px; background:var(--accent); border-radius:2px; vertical-align:middle; }
  code { background:#0b0e13; border:1px solid var(--line); padding:1px 5px; border-radius:4px; }
  a { color:#58a6ff; }
`;

export function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${BASE_CSS}</style></head>
<body><main>${body}</main></body></html>`;
}

function daysOverdue(invoice, nowIso) {
  const ms = new Date(nowIso).getTime() - new Date(invoice.dueAt).getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}

/** @param {any} report @param {any[]} invoices */
export function dashboardHtml(report, invoices, env = process.env) {
  const money = (c) => formatCents(c, 'USD');
  const mockBanner =
    env.STRIPE_SECRET_KEY ? '' :
      `<div class="banner"><strong>Mock payment mode.</strong> No <code>STRIPE_SECRET_KEY</code> is set, so payment links are fake and no money can move. Set the key to go live.</div>`;

  const agingMax = Math.max(1, ...report.ageing.map((b) => b.cents));
  const rows = invoices
    .slice()
    .reverse()
    .map((i) => {
      const overdue = daysOverdue(i, report.generatedAt);
      const stages = Object.keys(i.dunning ?? {});
      const lastStage = stages[stages.length - 1];
      const status =
        i.status === 'paid' ? '<span class="ok">paid</span>'
          : i.status === 'void' ? '<span class="pill">void</span>'
            : overdue > 0 ? `<span class="${overdue > 21 ? 'bad' : 'warn'}">${overdue}d overdue</span>`
              : '<span class="pill">not due</span>';
      return `<tr>
        <td>${esc(i.number)}</td>
        <td>${esc(i.customer.email)}</td>
        <td>${money(i.amountCents)}</td>
        <td>${esc(i.dueAt.slice(0, 10))}</td>
        <td>${status}</td>
        <td>${lastStage ? esc(STAGE_LABEL[lastStage] ?? lastStage) : '<span class="pill">none</span>'}</td>
      </tr>`;
    })
    .join('');

  return page(
    'GetPaid — recovery dashboard',
    `${mockBanner}
    <h1>GetPaid</h1>
    <p class="sub">Overdue invoices, chased automatically. Recovered so far: <strong class="ok">${money(report.recoveredCents)}</strong></p>

    <div class="grid">
      <div class="card"><div class="k">Recovered (all time)</div><div class="v ok">${money(report.recoveredCents)}</div><div class="n">${report.recoveredInWindowCount} payments in ${report.windowDays}d</div></div>
      <div class="card"><div class="k">Outstanding</div><div class="v">${money(report.outstandingCents)}</div><div class="n">${report.counts.open} open invoices</div></div>
      <div class="card"><div class="k">Overdue</div><div class="v warn">${money(report.overdueCents)}</div><div class="n">recoverable now</div></div>
      <div class="card"><div class="k">Recovery rate</div><div class="v">${(report.recoveryRateBps / 100).toFixed(1)}%</div><div class="n">of ${money(report.billedCents)} billed</div></div>
      <div class="card"><div class="k">Avg days late paid</div><div class="v">${report.avgDaysLateDays ?? '—'}</div><div class="n">negative = paid early</div></div>
      <div class="card"><div class="k">Dunning sent</div><div class="v">${report.dunning.sent}</div><div class="n">${report.dunning.sentInWindow} in last ${report.windowDays}d</div></div>
    </div>

    <h2>Receivables ageing</h2>
    <table><tr><th>Bucket</th><th>Invoices</th><th>Amount</th><th></th></tr>
      ${report.ageing.map((b) => `<tr><td>${esc(b.label)}</td><td>${b.count}</td><td>${money(b.cents)}</td>
        <td class="bars"><span style="width:${Math.round((b.cents / agingMax) * 160)}px"></span></td></tr>`).join('')}
    </table>

    <h2>Invoices</h2>
    <table><tr><th>Number</th><th>Customer</th><th>Amount</th><th>Due</th><th>Status</th><th>Chasing</th></tr>
      ${rows || '<tr><td colspan="6" class="sub">No invoices yet.</td></tr>'}
    </table>`,
  );
}

/** @param {any[]} plans */
export function pricingHtml(plans, env = process.env) {
  const money = (c) => formatCents(c, 'USD');
  return page(
    'GetPaid — pricing',
    `<h1>Pricing</h1>
     <p class="sub">Priced against what it recovers: one collected invoice pays for a year.</p>
     <div class="grid">
       ${plans.map((p) => `<div class="card">
         <div class="k">${esc(p.name)}</div>
         <div class="v">${money(p.monthlyCents)}<span class="n">/mo</span></div>
         <div class="n">${money(p.annualCents)}/yr</div>
         <div class="n" style="margin-top:8px">${esc(p.blurb)}</div>
         <form method="post" action="/api/subscribe"><input type="hidden" name="planId" value="${esc(p.id)}">
         <button style="margin-top:10px">Start ${esc(p.name)}</button></form>
       </div>`).join('')}
     </div>
     ${env.STRIPE_SECRET_KEY ? '' : '<div class="banner" style="margin-top:20px"><strong>Mock mode:</strong> checkout URLs are fake until <code>STRIPE_SECRET_KEY</code> is set.</div>'}`,
  );
}

