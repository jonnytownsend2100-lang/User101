/**
 * Money Engine UI — vanilla ES modules, no framework, no build step.
 * All arithmetic happens on the server in src/engine.mjs so the browser and
 * the CLI can never disagree about the numbers.
 */

const $ = (id) => document.getElementById(id);

const NUMERIC_IDS = [
  'price', 'units', 'growthPct', 'churnPct', 'variableCostPct',
  'fixedCostMonthly', 'acqCostPerUnit', 'startupCost', 'taxRatePct',
  'hoursPerWeek', 'months', 'target',
];

/** Slider/input labels that show their value inline. */
const SUFFIX = {
  growthPct: '%/mo', churnPct: '%/mo', variableCostPct: '%', taxRatePct: '%',
  hoursPerWeek: 'h', months: 'mo',
};

let playbooks = [];
let inFlight = null;

const money = (v, dp = 0) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
};
const num = (v, dp = 1) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—');
const pct = (v, dp = 1) => (Number.isFinite(v) ? `${num(v, dp)}%` : '—');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readInputs() {
  const out = { label: $('label').value.trim() || 'Scenario', mode: $('mode').value };
  for (const id of NUMERIC_IDS) {
    if (id === 'target') continue;
    out[id] = Number($(id).value);
  }
  const target = Number($('target').value);
  if (Number.isFinite(target) && target > 0) out.targetMonthlyNet = target;
  return out;
}

function applyInputs(input) {
  if (input.label) $('label').value = input.label;
  if (input.mode) $('mode').value = input.mode;
  for (const id of NUMERIC_IDS) {
    if (input[id] !== undefined && input[id] !== null) $(id).value = input[id];
  }
  syncOutputs();
  toggleChurn();
}

/** Keep the inline value readouts next to each slider in step with the input. */
function syncOutputs() {
  for (const id of Object.keys(SUFFIX)) {
    const out = $(`${id}-out`);
    if (out) out.textContent = `${num(Number($(id).value), id === 'months' || id === 'hoursPerWeek' ? 0 : 1)}${SUFFIX[id]}`;
  }
}

function toggleChurn() {
  const recurring = $('mode').value === 'recurring';
  $('churn-field').style.display = recurring ? '' : 'none';
}

/* ---------------------------------------------------------------- rendering */

function card(key, value, sub, tone) {
  return `<div class="card"><div class="k">${esc(key)}</div>
    <div class="v ${tone ?? ''}">${value}</div><div class="sub">${sub}</div></div>`;
}

function renderHeadline(r) {
  const s = r.steadyState;
  const tone = s.netProfit > 0 ? 'good' : s.netProfit === 0 ? 'mid' : 'bad';
  const hourlyTone = r.effectiveHourlyRate === null ? '' : r.effectiveHourlyRate >= 20 ? 'good' : 'mid';
  const cards = [
    card(`Profit in month ${s.month}`, money(s.netProfit), `${money(s.revenue)} revenue · ${pct(s.netMarginPct)} margin`, tone),
    card('Trailing 12-month profit', money(r.annualNet), `${money(r.annualRevenue)} revenue over the period`, r.annualNet > 0 ? 'good' : 'bad'),
    card('Effective hourly rate', r.effectiveHourlyRate === null ? '—' : `${money(r.effectiveHourlyRate, 2)}/hr`, `${num(r.config.hoursPerWeek, 0)} h/week · ${num(r.annualHours, 0)} h/yr`, hourlyTone),
    card('Break-even volume', r.breakEvenUnits === null ? 'Unreachable' : `${num(r.breakEvenUnits)}/mo`, r.breakEvenUnits === null ? 'every unit loses money at this price' : `${money(r.breakEvenRevenue)} of monthly revenue`, r.breakEvenUnits === null ? 'bad' : ''),
    card('First profitable month', r.monthsToBreakEven === null ? 'Never' : `Month ${r.monthsToBreakEven}`, r.monthsToPayback === null ? 'setup cost never repaid' : `setup repaid in month ${r.monthsToPayback}`, r.monthsToBreakEven === null ? 'bad' : ''),
    card('Cash you must front', money(Math.abs(r.peakInvestment)), `contribution per unit ${money(r.contributionPerUnit, 2)}`, ''),
  ];
  $('headline').innerHTML = cards.join('');
}

/** Inline SVG chart: cumulative profit line, monthly profit bars, zero axis. */
function renderChart(r) {
  const rows = r.series;
  const w = 760;
  const h = 300;
  const pad = { l: 58, r: 14, t: 14, b: 26 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;

  const cum = rows.map((d) => d.cumulativeNet);
  const monthly = rows.map((d) => d.netProfit);
  const lo = Math.min(0, ...cum, ...monthly);
  const hi = Math.max(0, ...cum, ...monthly);
  const span = hi - lo || 1;
  const x = (i) => pad.l + (rows.length === 1 ? innerW / 2 : (i / (rows.length - 1)) * innerW);
  const y = (v) => pad.t + innerH - ((v - lo) / span) * innerH;

  const barW = Math.max(2, Math.min(18, innerW / rows.length - 3));
  const bars = rows
    .map((d, i) => {
      const top = Math.min(y(d.netProfit), y(0));
      const height = Math.max(1, Math.abs(y(d.netProfit) - y(0)));
      const fill = d.netProfit >= 0 ? '#1f6f43' : '#7f2a2a';
      return `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${height.toFixed(1)}" fill="${fill}" opacity="0.75"><title>Month ${d.month}: net ${money(d.netProfit)}</title></rect>`;
    })
    .join('');

  const line = cum.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(rows.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  const setup = -r.config.startupCost;
  const setupLine =
    setup < 0 && setup >= lo
      ? `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(setup).toFixed(1)}" y2="${y(setup).toFixed(1)}" stroke="#fbbf24" stroke-dasharray="5 4" stroke-width="1" opacity="0.8" />
         <text x="${pad.l + 4}" y="${(y(setup) - 5).toFixed(1)}" fill="#fbbf24" font-size="10">setup cost ${money(setup)}</text>`
      : '';

  const paybackMark =
    r.monthsToPayback !== null
      ? (() => {
          const i = r.monthsToPayback - 1;
          return `<circle cx="${x(i).toFixed(1)}" cy="${y(rows[i].cumulativeNet).toFixed(1)}" r="4" fill="#4ade80" />
                  <text x="${(x(i) + 7).toFixed(1)}" y="${(y(rows[i].cumulativeNet) - 6).toFixed(1)}" fill="#4ade80" font-size="10">paid back</text>`;
        })()
      : '';

  const ticks = [hi, (hi + lo) / 2, lo].map(
    (v) =>
      `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#2a323e" stroke-width="1" />
       <text x="${pad.l - 6}" y="${(y(v) + 3.5).toFixed(1)}" fill="#97a3b4" font-size="10" text-anchor="end">${money(v)}</text>`
  ).join('');

  const xLabels = rows
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.month === 1 || d.month % Math.ceil(rows.length / 8) === 0)
    .map(({ d, i }) => `<text x="${x(i).toFixed(1)}" y="${h - 8}" fill="#97a3b4" font-size="10" text-anchor="middle">${d.month}</text>`)
    .join('');

  $('chart').innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Cumulative profit over ${rows.length} months">
    ${ticks}
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#5a6675" stroke-width="1.5" />
    ${bars}
    <path d="${area}" fill="#4ade80" opacity="0.10" />
    <path d="${line}" fill="none" stroke="#4ade80" stroke-width="2.2" stroke-linejoin="round" />
    ${setupLine}
    ${paybackMark}
    ${xLabels}
    <text x="${pad.l}" y="11" fill="#97a3b4" font-size="10">bars = monthly net · line = cumulative · x = month</text>
  </svg>`;
}


function renderTable(r) {
  const cols = [
    ['month', 'Mo', 0], ['units', 'Units', 1], ['revenue', 'Revenue', 0],
    ['variableCost', 'Delivery', 0], ['opex', 'Opex', 0], ['operatingProfit', 'Operating', 0],
    ['tax', 'Tax', 0], ['netProfit', 'Net', 0], ['cumulativeNet', 'Cumulative', 0],
  ];
  const head = `<tr>${cols.map(([, label]) => `<th>${label}</th>`).join('')}</tr>`;
  const body = r.series
    .map((row) => {
      const cells = cols
        .map(([key, , dp]) => {
          const v = row[key];
          if (key === 'month') return `<td>${v}</td>`;
          const cls = key === 'netProfit' || key === 'cumulativeNet' || key === 'operatingProfit' ? (v < 0 ? 'neg' : 'pos') : '';
          return `<td class="${cls}">${num(v, dp)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  $('table-wrap').innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderSensitivity(r) {
  const list = r.sensitivities;
  const top = Math.max(...list.map((s) => Math.abs(s.annualNetDelta ?? 0)), 1);
  $('sensitivity').innerHTML = list
    .map((s, i) => {
      const delta = s.annualNetDelta ?? 0;
      const width = Math.max(1.5, (Math.abs(delta) / top) * 100);
      const cls = !s.effective ? 'muted' : delta < 0 ? 'neg' : '';
      return `<div class="lever">
        <div class="lever-head">
          <span>${i + 1}. ${esc(s.label)} <span class="lever-change">${esc(s.change)}</span></span>
          <span class="amt ${cls}">${s.effective ? `${delta >= 0 ? '+' : ''}${money(delta)}/yr` : 'n/a'}</span>
        </div>
        <div class="lever-track"><div class="lever-fill" style="width:${s.effective ? width : 0}%"></div></div>
      </div>`;
    })
    .join('');
}

function renderGoal(r) {
  const g = r.goal;
  if (!g) {
    $('goal-body').innerHTML = '<p class="hint">Set a target profit above to see what it takes.</p>';
    return;
  }
  if (!g.reachable) {
    $('goal-body').innerHTML = `<p class="risk">${esc(g.note)}</p>`;
    return;
  }
  const current = r.steadyState.units;
  const ratio = current > 0 ? g.requiredUnits / current : null;
  $('goal-body').innerHTML = `<div class="goal-grid">
    <div class="goal-box"><div class="k">Customers needed</div><div class="v">${num(g.requiredUnits)}</div>
      <div class="sub hint">${ratio ? `${num(ratio * 100, 0)}% of your current ${num(current)}` : ''}</div></div>
    <div class="goal-box"><div class="k">…or price needed at ${num(current)} customers</div><div class="v">${money(g.requiredPrice, 2)}</div>
      <div class="sub hint">per unit, holding volume and costs fixed</div></div>
    <div class="goal-box"><div class="k">Target</div><div class="v">${money(g.targetMonthlyNet)}/mo</div>
      <div class="sub hint">net, after delivery costs, fixed costs and tax</div></div>
  </div>`;
}

function renderWarnings(r) {
  const panel = $('warnings-panel');
  if (!r.warnings.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('warnings').innerHTML = r.warnings.map((w) => `<li>${esc(w)}</li>`).join('');
}

function render(r) {
  renderHeadline(r);
  renderChart(r);
  renderTable(r);
  renderSensitivity(r);
  renderGoal(r);
  renderWarnings(r);
}


/* ------------------------------------------------------------------ plumbing */

async function run() {
  const inputs = readInputs();
  $('status').textContent = 'Modelling…';
  try {
    const res = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inputs),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
    render(body);
    $('status').textContent = `Model: ${body.config.mode} · ${num(body.config.months, 0)} months`;
  } catch (err) {
    $('status').textContent = `Could not model that: ${err.message}`;
  }
}

function schedule() {
  clearTimeout(inFlight);
  inFlight = setTimeout(run, 120);
}

function renderPlaybooks() {
  const select = $('playbook');
  select.innerHTML =
    '<option value="">Blank scenario…</option>' +
    playbooks.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');

  $('playbook-grid').innerHTML = playbooks
    .map(
      (p) => `<article class="pb">
      <div><span class="pill">${p.mode === 'recurring' ? 'recurring' : 'one-off'} · difficulty ${p.difficulty}/5</span></div>
      <h3>${esc(p.name)}</h3>
      <p class="hint">${esc(p.summary)}</p>
      <dl>
        <dt>Startup</dt><dd>${money(p.startupCostRange[0])}–${money(p.startupCostRange[1])}</dd>
        <dt>First dollar</dt><dd>${p.monthsToFirstDollar[0]}–${p.monthsToFirstDollar[1]} months</dd>
        <dt>Realistic net</dt><dd>${money(p.realisticMonthlyNetRange[0])}–${money(p.realisticMonthlyNetRange[1])}/mo</dd>
        <dt>Your hours</dt><dd>${p.hoursPerWeek[0]}–${p.hoursPerWeek[1]} h/week</dd>
      </dl>
      <p class="risk"><strong>Main risk:</strong> ${esc(p.keyRisk)}</p>
      <p class="hint"><strong>Why most fail:</strong> ${esc(p.whyMostFail)}</p>
      <ol>${p.firstThreeSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <button type="button" data-load="${esc(p.id)}">Load into the modeller</button>
    </article>`
    )
    .join('');

  $('playbook-grid').addEventListener('click', (e) => {
    const id = e.target?.dataset?.load;
    if (!id) return;
    const pb = playbooks.find((p) => p.id === id);
    if (!pb) return;
    applyInputs({ ...pb.preset, label: pb.name });
    $('playbook').value = pb.id;
    run();
    $('modeller').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function boot() {
  try {
    const res = await fetch('/api/playbooks');
    playbooks = (await res.json()).playbooks ?? [];
  } catch {
    playbooks = [];
  }
  renderPlaybooks();

  $('playbook').addEventListener('change', (e) => {
    const pb = playbooks.find((p) => p.id === e.target.value);
    if (!pb) return;
    applyInputs({ ...pb.preset, label: pb.name });
    run();
  });

  $('mode').addEventListener('change', () => {
    toggleChurn();
    run();
  });

  for (const id of [...NUMERIC_IDS, 'label']) {
    $(id).addEventListener('input', () => {
      syncOutputs();
      schedule();
    });
  }

  $('reset').addEventListener('click', () => {
    $('playbook').value = '';
    applyInputs({
      label: 'My side hustle', mode: 'recurring', price: 50, units: 20, growthPct: 5, churnPct: 3,
      variableCostPct: 15, fixedCostMonthly: 100, acqCostPerUnit: 5, startupCost: 0,
      taxRatePct: 25, hoursPerWeek: 10, months: 24, target: 3000,
    });
    run();
  });

  $('export').addEventListener('click', async () => {
    const res = await fetch('/api/export.csv', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(readInputs()),
    });
    if (!res.ok) {
      $('status').textContent = 'Export failed.';
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'money-engine-projection.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  syncOutputs();
  toggleChurn();
  run();
}

boot();

