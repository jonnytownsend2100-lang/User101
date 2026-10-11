import { format } from './money.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--bg:#0b0f14;--panel:#131a22;--line:#22303c;--ink:#e7eef5;--dim:#8fa3b4;--accent:#3ddc97;--warn:#ffb454}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:40px 20px}
h1{font-size:34px;margin:0 0 6px;letter-spacing:-.5px}h2{font-size:19px;margin:32px 0 12px}
.dim{color:var(--dim)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
.card h3{margin:0 0 4px;font-size:17px}.price{font-size:26px;font-weight:650;margin:10px 0}
button{background:var(--accent);color:#06231a;border:0;border-radius:9px;padding:11px 16px;font-weight:650;cursor:pointer;font-size:15px}
button.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
input{background:#0e151d;border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:10px 12px;width:100%;font-size:15px}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:12px 0 5px}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat b{display:block;font-size:23px;margin-top:4px;font-weight:650}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.key{background:#0e151d;border:1px dashed var(--line);border-radius:9px;padding:12px;word-break:break-all}
.note{border-left:3px solid var(--warn);padding:8px 14px;color:var(--dim);background:#141b23;border-radius:0 8px 8px 0}
.bad{border-left-color:#ff6b6b}a{color:var(--accent)}
`;

export function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

const priceLabel = (p) => {
  const base = format(p.amount, p.currency);
  if (p.payWhatYouWant) return `${format(p.minimumAmount, p.currency)}+`;
  return p.interval ? `${base}<span class="dim" style="font-size:15px">/${p.interval}</span>` : base;
};

export function landing({ products, provider, notice = null }) {
  const cards = products
    .map(
      (p) => `<div class="card" data-product="${esc(p.slug)}">
      <h3>${esc(p.name)}</h3><div class="dim">${esc(p.tagline)}</div>
      <div class="price">${priceLabel(p)}</div>
      <div class="dim" style="min-height:44px">${esc(p.description)}</div>
      <label for="email-${esc(p.slug)}">Your email</label>
      <input id="email-${esc(p.slug)}" type="email" placeholder="you@example.com">
      ${p.payWhatYouWant ? `<label for="amt-${esc(p.slug)}">Amount (${esc(p.currency.toUpperCase())})</label><input id="amt-${esc(p.slug)}" type="number" min="${(p.minimumAmount / 100).toFixed(2)}" step="1" value="${(p.minimumAmount / 100).toFixed(2)}">` : ''}
      <div style="margin-top:14px"><button data-buy="${esc(p.slug)}">Buy now</button></div>
      <div class="dim" data-msg="${esc(p.slug)}" style="margin-top:10px;font-size:13px"></div>
    </div>`,
    )
    .join('');

  return layout(
    'Mint - software you can sell',
    `<h1>Mint</h1>
  <p class="dim">A complete funnel: product page, checkout, signed license keys, refunds, and a ledger that reports net after fees.</p>
  ${notice ? `<p class="note">${esc(notice)}</p>` : ''}
  <p class="dim mono" style="font-size:13px">payment provider: ${esc(provider)}</p>
  <h2>For sale</h2><div class="grid">${cards}</div>
  <h2>Operate it</h2>
  <p class="dim">The owner console lives at <a href="/dashboard">/dashboard</a> (needs the admin token printed at boot).</p>
  <script>
  const post = async (url, body) => (await fetch(url, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
  document.querySelectorAll('[data-buy]').forEach((btn) => btn.addEventListener('click', async () => {
    const slug = btn.dataset.buy;
    const msg = document.querySelector('[data-msg="'+slug+'"]');
    const email = document.getElementById('email-'+slug).value;
    const amountEl = document.getElementById('amt-'+slug);
    msg.textContent = 'creating checkout...';
    try {
      const payload = { productId: slug, email };
      if (amountEl) payload.amountMinor = Math.round(Number(amountEl.value) * 100);
      const res = await post('/api/checkout', payload);
      if (res.checkoutUrl) { msg.textContent = 'redirecting...'; location.href = res.checkoutUrl; }
      else { msg.textContent = res.error || 'checkout failed'; }
    } catch (e) { msg.textContent = String(e); }
  }));
  </script>`,
  );
}

/** The simulated checkout. Clearly labelled: it must never look like real payment. */
export function mockPay({ order }) {
  return layout(
    'Simulated checkout',
    `<h1>Simulated checkout</h1>
  <p class="note">No money moves here. This is the <b>mock</b> provider: it exists so the funnel can be tested end to end offline. Set <span class="mono">MINT_PROVIDER=stripe</span> and add <span class="mono">STRIPE_SECRET_KEY</span> for real payments.</p>
  <div class="card" style="max-width:460px;margin-top:20px">
    <h3>${esc(order.productName)}</h3>
    <div class="price">${format(order.amount, order.currency)}</div>
    <div class="dim">${esc(order.email)} &middot; order <span class="mono">${esc(order.id)}</span></div>
    <div class="row" style="margin-top:16px">
      <button id="pay">Pay ${format(order.amount, order.currency)} (simulated)</button>
      <button class="ghost" id="fail">Simulate failure</button>
    </div>
    <div class="dim" id="msg" style="margin-top:12px"></div>
  </div>
  <script>
  const settle = async (type) => {
    const res = await fetch('/api/webhook/mock', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orderId:'${order.id}',claimToken:'${order.claimToken}',type})});
    const json = await res.json();
    if (json.ok && type === 'paid') location.href = json.redirect;
    else document.getElementById('msg').textContent = json.error || 'ok';
  };
  document.getElementById('pay').onclick = () => settle('paid');
  document.getElementById('fail').onclick = () => { document.getElementById('msg').textContent = 'buyer abandoned checkout (no webhook sent)'; };
  </script>`,
  );
}

export function thanks({ order, license, claimUrl }) {
  return layout(
    'Thanks',
    `<h1>Payment received</h1>
  <p class="dim">${esc(order.productName)} &middot; ${format(order.amount, order.currency)} &middot; <span class="mono">${esc(order.id)}</span></p>
  <div class="card" style="margin-top:18px">
    <h3>Your license key</h3>
    <p class="dim">Signed with HMAC-SHA256. Anyone can verify it offline against your public verify endpoint -- no database lookup needed.</p>
    <div class="key mono" id="key">${esc(license?.key ?? 'no license for this product')}</div>
    <div class="row" style="margin-top:14px"><button id="copy" class="ghost">Copy key</button></div>
    <div class="dim" style="margin-top:10px;font-size:13px">Verify at <span class="mono">POST /api/verify {"key":"..."}</span></div>
  </div>
  <p class="dim" style="margin-top:18px">Bookmark this page -- it is your only copy: <span class="mono">${esc(claimUrl)}</span></p>
  <script>document.getElementById('copy').onclick = () => navigator.clipboard.writeText(document.getElementById('key').textContent).then(() => document.getElementById('copy').textContent = 'Copied');</script>`,
  );
}

const sparkline = (series) => {
  const w = 640;
  const h = 90;
  const max = Math.max(1, ...series.map((d) => d.net));
  const step = series.length > 1 ? w / (series.length - 1) : w;
  const pts = series.map((d, i) => `${(i * step).toFixed(1)},${(h - (d.net / max) * (h - 8)).toFixed(1)}`);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="net revenue, last ${series.length} days">
    <polyline fill="none" stroke="#3ddc97" stroke-width="2" points="${pts.join(' ')}"/>
    <line x1="0" y1="${h - 0.5}" x2="${w}" y2="${h - 0.5}" stroke="#22303c"/>
  </svg>`;
};

export function dashboard({ m, provider, days }) {
  const rows = m.byProduct
    .map(
      (p) => `<tr><td>${esc(p.name)}</td><td class="mono">${p.orders}</td><td class="mono">${format(p.gross)}</td>
      <td class="mono dim">-${format(p.fees)}</td><td class="mono dim">-${format(p.refunds)}</td><td class="mono"><b>${format(p.net)}</b></td></tr>`,
    )
    .join('') || '<tr><td colspan="6" class="dim">no sales yet</td></tr>';

  return layout(
    'Mint - owner console',
    `<h1>Owner console</h1>
  <p class="dim">Provider <span class="mono">${esc(provider)}</span> &middot; generated ${esc(m.generatedAt)}</p>
  <div class="grid" style="margin-top:18px">
    <div class="stat">Net revenue<b>${format(m.net)}</b><span class="dim" style="font-size:12px">gross ${format(m.gross)} - fees ${format(m.fees)} - refunds ${format(m.refunds)}</span></div>
    <div class="stat">MRR<b>${format(m.mrr)}</b><span class="dim" style="font-size:12px">ARR ${format(m.arr)}</span></div>
    <div class="stat">Paid orders<b>${m.orders.paid}</b><span class="dim" style="font-size:12px">${m.orders.pending} pending, ${m.orders.failed} failed</span></div>
    <div class="stat">Margin<b>${(m.margin * 100).toFixed(1)}%</b><span class="dim" style="font-size:12px">conversion ${(m.conversion * 100).toFixed(1)}%</span></div>
    <div class="stat">Customers<b>${m.customers}</b><span class="dim" style="font-size:12px">${m.licenses.active} active licenses</span></div>
  </div>
  <h2>Net revenue, last ${days} days</h2>
  ${sparkline(m.series)}
  <h2>By product</h2>
  <table><thead><tr><th>Product</th><th>Orders</th><th>Gross</th><th>Fees</th><th>Refunds</th><th>Net</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="dim" style="margin-top:22px">Refresh for the current numbers. This page reads <span class="mono">/api/metrics</span>, so it is trivially scriptable.</p>`,
  );
}

export function errorPage(status, message) {
  return layout(`Error ${status}`, `<h1>${status}</h1><p class="note bad">${esc(message)}</p><p><a href="/">Back to the store</a></p>`);
}
