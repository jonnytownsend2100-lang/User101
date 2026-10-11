/**
 * Money Engine — a cash-flow model for small businesses and side hustles.
 *
 * Honest framing: no app prints money. What this does is take the variables a
 * person actually controls (price, volume, growth, churn, costs, taxes) and
 * turn them into the numbers that drive decisions: steady-state profit,
 * break-even volume, payback period, effective hourly rate, and — most
 * usefully — a ranked list of which single lever moves profit the most.
 *
 * The model is deliberately simple and explainable. Every number the UI shows
 * can be recomputed by hand from the inputs. No hidden magic.
 */

export const MODE_RECURRING = 'recurring'; // subscriptions, memberships, retainers
export const MODE_FLOW = 'flow'; //         one-off sales, projects, orders

export const WEEKS_PER_MONTH = 52 / 12; // 4.333...

/** Numeric fields, their defaults, and legal ranges. */
const NUMERIC_FIELDS = {
  price: { def: 50, min: 0 },
  units: { def: 20, min: 0 },
  growthPct: { def: 5, min: -100 },
  churnPct: { def: 3, min: 0, max: 100 },
  variableCostPct: { def: 15, min: 0, max: 100 },
  fixedCostMonthly: { def: 100, min: 0 },
  acqCostPerUnit: { def: 5, min: 0 },
  taxRatePct: { def: 25, min: 0, max: 100 },
  startupCost: { def: 0, min: 0 },
  hoursPerWeek: { def: 10, min: 0 },
  months: { def: 24, min: 1, max: 600, integer: true },
};

export class InputError extends Error {}

function num(raw, key) {
  const spec = NUMERIC_FIELDS[key];
  if (raw === undefined || raw === null || raw === '') return spec.def;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw new InputError(`"${key}" must be a number, got ${JSON.stringify(raw)}`);
  }
  let out = spec.integer ? Math.round(v) : v;
  if (spec.min !== undefined) out = Math.max(spec.min, out);
  if (spec.max !== undefined) out = Math.min(spec.max, out);
  return out;
}

export function normalize(input = {}) {
  const mode =
    input.mode === MODE_RECURRING || input.mode === MODE_FLOW
      ? input.mode
      : MODE_RECURRING;
  const cfg = { label: String(input.label ?? 'Scenario'), mode };
  for (const key of Object.keys(NUMERIC_FIELDS)) cfg[key] = num(input[key], key);
  // Churn is only meaningful for recurring models.
  if (cfg.mode === MODE_FLOW) cfg.churnPct = 0;
  cfg.hoursPerMonth = cfg.hoursPerWeek * WEEKS_PER_MONTH;
  return cfg;
}

/**
 * Pre-tax profit per unit at steady state.
 *
 * `price * (1 - varCost)`      value left after cost of goods
 * `- acqCost * (growth+churn)` acquisition paid on the units you must add
 *
 * The second term is why growth is not free. To grow the base by `g` while
 * losing `c` to churn, you have to acquire `g + c` percent of the base every
 * month, forever — churned customers must be replaced before any growth
 * happens. Charging CAC only on net growth (`g - c`) is the single most common
 * way a subscription model gets modelled too optimistically.
 */
export function contributionPerUnit(cfg) {
  const afterCogs = cfg.price * (1 - cfg.variableCostPct / 100);
  return afterCogs - cfg.acqCostPerUnit * newUnitRate(cfg);
}

/** Units acquired per month, as a fraction of the existing base. */
function newUnitRate(cfg) {
  return cfg.mode === MODE_RECURRING ? (cfg.growthPct + cfg.churnPct) / 100 : 1;
}

/** The unit count on which the model starts, month by month. */
function unitPath(cfg) {
  const path = [];
  let u = cfg.units;
  for (let m = 1; m <= cfg.months; m++) {
    if (m > 1) {
      u =
        cfg.mode === MODE_RECURRING
          ? u * (1 + (cfg.growthPct - cfg.churnPct) / 100)
          : u * (1 + cfg.growthPct / 100);
      u = Math.max(0, u);
    }
    path.push(u);
  }
  return path;
}

function taxOn(operatingProfit, taxRatePct) {
  // Losses are not credited back — deliberately conservative.
  if (operatingProfit <= 0) return 0;
  return operatingProfit * (taxRatePct / 100);
}

/** One month of the model. Pure function of (cfg, units, newUnits). */
export function monthRow(cfg, units, newUnits) {
  const revenue = units * cfg.price;
  const variableCost = revenue * (cfg.variableCostPct / 100);
  const grossProfit = revenue - variableCost;

  const acquired = Math.max(0, newUnits);
  const acquisitionCost = acquired * cfg.acqCostPerUnit;
  const opex = cfg.fixedCostMonthly + acquisitionCost;
  const operatingProfit = grossProfit - opex;
  const tax = taxOn(operatingProfit, cfg.taxRatePct);
  const netProfit = operatingProfit - tax;

  return {
    revenue,
    variableCost,
    grossProfit,
    newUnits: acquired,
    acquisitionCost,
    opex,
    operatingProfit,
    tax,
    netProfit,
    hourlyProfit: cfg.hoursPerMonth > 0 ? netProfit / cfg.hoursPerMonth : null,
  };
}

export function project(cfg) {
  const rows = [];
  let cumulative = -cfg.startupCost;
  const units = unitPath(cfg);
  const rate = newUnitRate(cfg);
  for (let m = 0; m < cfg.months; m++) {
    const prevUnits = m === 0 ? 0 : units[m - 1];
    // Month 1 acquires the whole opening base; after that you only pay for
    // replacements and additions.
    const newUnits = m === 0 ? units[0] : prevUnits * rate;
    const row = monthRow(cfg, units[m], newUnits);
    cumulative += row.netProfit;
    rows.push({ month: m + 1, units: units[m], cumulativeNet: cumulative, ...row });
  }
  return rows;
}

/** Sum the last `n` months of a field, falling back to the whole series. */
function trailing(rows, field, n = 12) {
  const slice = rows.length >= n ? rows.slice(-n) : rows;
  return slice.reduce((a, r) => a + r[field], 0);
}

function firstMonthWhere(rows, pred) {
  const i = rows.findIndex(pred);
  return i === -1 ? null : rows[i].month;
}

function round(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Rank the levers by how much an equal-effort improvement moves the annual
 * bottom line. This is the part that changes what a person does next week.
 *
 * Each lever is nudged 10% in the direction that helps (costs and churn go
 * down, price and volume go up) and the model is re-run.
 */
export function sensitivities(cfg, baseAnnualNet) {
  const bumps = [
    { id: 'price', label: 'Raise price 10%', field: 'price', pct: 10 },
    { id: 'units', label: 'Acquire 10% more customers', field: 'units', pct: 10 },
    { id: 'fixedCostMonthly', label: 'Cut fixed costs 10%', field: 'fixedCostMonthly', pct: -10 },
    { id: 'variableCostPct', label: 'Cut delivery cost 10%', field: 'variableCostPct', pct: -10 },
    { id: 'acqCostPerUnit', label: 'Cut acquisition cost 10%', field: 'acqCostPerUnit', pct: -10 },
    { id: 'churnPct', label: 'Reduce churn 10%', field: 'churnPct', pct: -10 },
    { id: 'growthPct', label: 'Grow 10% faster', field: 'growthPct', pct: 10 },
  ];
  // Note: hours are deliberately absent. Profit in this model does not depend
  // on hours worked — hours are the denominator of the effective hourly rate,
  // which is reported separately so the two ideas are not conflated.

  const results = [];
  for (const bump of bumps) {
    const baseValue = cfg[bump.field];
    const changed = baseValue * (1 + bump.pct / 100);
    if (baseValue === 0) {
      results.push({
        id: bump.id,
        label: bump.label,
        change: 'no effect — this input is 0',
        annualNetDelta: 0,
        effective: false,
      });
      continue;
    }
    const altAnnual = trailing(project({ ...cfg, [bump.field]: changed }), 'netProfit');
    const delta = altAnnual - baseAnnualNet;
    results.push({
      id: bump.id,
      label: bump.label,
      change: `${baseValue} → ${round(changed)}`,
      annualNetDelta: delta,
      annualNetDeltaPct: baseAnnualNet !== 0 ? (delta / Math.abs(baseAnnualNet)) * 100 : null,
      effective: true,
    });
  }
  results.sort((a, b) => b.annualNetDelta - a.annualNetDelta);
  return results;
}


/**
 * What would it take to clear a target monthly profit at steady state?
 * Solves for required units and for required price, each holding everything
 * else fixed.
 */
export function goalSeek(cfg, targetMonthlyNet) {
  const target = Number(targetMonthlyNet);
  if (!Number.isFinite(target)) throw new InputError('targetMonthlyNet must be a number');
  const keep = 1 - cfg.taxRatePct / 100;
  const preTaxTarget = keep > 0 ? target / keep : target;
  const cpu = contributionPerUnit(cfg);
  const reachable = cpu > 0;

  const requiredUnits = reachable
    ? Math.max(0, (preTaxTarget + cfg.fixedCostMonthly) / cpu)
    : null;

  // Required price: solve the steady-state profit equation for `price`.
  //   profit = units * (price*(1-v) - acq*(g+c)) - fixed
  let requiredPrice = null;
  if (cfg.units > 0) {
    const perUnitTarget = (preTaxTarget + cfg.fixedCostMonthly) / cfg.units;
    const rate = cfg.mode === MODE_RECURRING ? (cfg.growthPct + cfg.churnPct) / 100 : 1;
    const denom = 1 - cfg.variableCostPct / 100;
    if (denom > 0.0001) {
      const p = (perUnitTarget + cfg.acqCostPerUnit * rate) / denom;
      if (Number.isFinite(p) && p > 0) requiredPrice = p;
    }
  }

  return {
    targetMonthlyNet: target,
    requiredUnits,
    requiredPrice,
    reachable,
    note: reachable
      ? null
      : 'With this price and cost structure every extra unit loses money, so no volume can reach the target. Fix price or delivery cost first.',
  };
}

export function simulate(input = {}) {
  const cfg = normalize(input);
  const rows = project(cfg);
  const last = rows[rows.length - 1];
  const annualNet = trailing(rows, 'netProfit');
  const annualRevenue = trailing(rows, 'revenue');
  const annualHours = cfg.hoursPerWeek * 52;
  const cpu = contributionPerUnit(cfg);
  const breakEvenUnits = cpu > 0 ? cfg.fixedCostMonthly / cpu : null;

  return {
    config: cfg,
    series: rows,
    steadyState: {
      month: last.month,
      units: last.units,
      revenue: last.revenue,
      grossProfit: last.grossProfit,
      operatingProfit: last.operatingProfit,
      netProfit: last.netProfit,
      netMarginPct: last.revenue > 0 ? (last.netProfit / last.revenue) * 100 : null,
      hourlyProfit: last.hourlyProfit,
    },
    annualNet,
    annualRevenue,
    annualHours,
    effectiveHourlyRate: annualHours > 0 ? annualNet / annualHours : null,
    contributionPerUnit: cpu,
    breakEvenUnits,
    breakEvenRevenue: breakEvenUnits !== null ? breakEvenUnits * cfg.price : null,
    monthsToBreakEven: firstMonthWhere(rows, (r) => r.operatingProfit > 0),
    monthsToPayback: firstMonthWhere(rows, (r) => r.cumulativeNet >= 0),
    peakInvestment: Math.min(...rows.map((r) => r.cumulativeNet), 0),
    totalNet: rows.reduce((a, r) => a + r.netProfit, 0),
    sensitivities: sensitivities(cfg, annualNet),
    warnings: buildWarnings(cfg, rows),
  };
}

function buildWarnings(cfg, rows) {
  const w = [];
  if (cfg.mode === MODE_RECURRING && cfg.churnPct >= cfg.growthPct) {
    w.push(
      `Churn (${cfg.churnPct}%/mo) meets or exceeds growth (${cfg.growthPct}%/mo): the customer base is flat or shrinking, so revenue never compounds.`
    );
  }
  if (contributionPerUnit(cfg) <= 0) {
    w.push(
      'Contribution per unit is zero or negative — each additional unit loses money. Volume will not fix this.'
    );
  }
  const last = rows[rows.length - 1];
  if (last.netProfit <= 0) {
    w.push('The model never reaches monthly profitability inside the time horizon.');
  } else if (cfg.hoursPerMonth > 0) {
    const hourly = last.netProfit / cfg.hoursPerMonth;
    if (hourly < 15) {
      w.push(
        `Effective rate is ${round(hourly)}/hr at the end of the horizon — hard to justify the hours.`
      );
    }
  }
  return w;
}

