import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  simulate,
  normalize,
  project,
  monthRow,
  goalSeek,
  sensitivities,
  contributionPerUnit,
  InputError,
  MODE_FLOW,
  MODE_RECURRING,
} from '../src/engine.mjs';

const close = (a, b, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

test('normalize applies defaults', () => {
  const cfg = normalize({});
  assert.equal(cfg.mode, MODE_RECURRING);
  assert.equal(cfg.price, 50);
  assert.equal(cfg.units, 20);
  assert.equal(cfg.months, 24);
  close(cfg.hoursPerMonth, 10 * (52 / 12));
});

test('normalize clamps out-of-range values', () => {
  const cfg = normalize({ taxRatePct: 500, churnPct: -20, months: 3.7, variableCostPct: 400 });
  assert.equal(cfg.taxRatePct, 100);
  assert.equal(cfg.churnPct, 0);
  assert.equal(cfg.months, 4);
  assert.equal(cfg.variableCostPct, 100);
});

test('normalize zeroes churn in flow mode', () => {
  assert.equal(normalize({ mode: MODE_FLOW, churnPct: 9 }).churnPct, 0);
  assert.equal(normalize({ mode: MODE_RECURRING, churnPct: 9 }).churnPct, 9);
});

test('normalize rejects non-numeric input', () => {
  assert.throws(() => normalize({ price: 'lots' }), InputError);
  assert.throws(() => simulate({ units: NaN }), InputError);
});

test('month 1 revenue is units * price', () => {
  const cfg = normalize({ price: 30, units: 10, variableCostPct: 20, fixedCostMonthly: 0, acqCostPerUnit: 0, taxRatePct: 0 });
  const row = monthRow(cfg, 10, 0);
  close(row.revenue, 300);
  close(row.grossProfit, 240);
  close(row.netProfit, 240);
});

test('flow mode compounds units by growth each month', () => {
  const cfg = normalize({ mode: MODE_FLOW, units: 100, growthPct: 10, months: 4 });
  const units = project(cfg).map((r) => Math.round(r.units));
  assert.deepEqual(units, [100, 110, 121, 133]);
});

test('recurring mode nets growth against churn', () => {
  const cfg = normalize({ mode: MODE_RECURRING, units: 100, growthPct: 10, churnPct: 4, months: 3 });
  const units = project(cfg).map((r) => Math.round(r.units * 100) / 100);
  assert.deepEqual(units, [100, 106, 112.36]);
});

test('recurring mode charges acquisition cost only on newly added units', () => {
  const cfg = normalize({ mode: MODE_RECURRING, units: 100, growthPct: 10, churnPct: 0, acqCostPerUnit: 5, price: 1, variableCostPct: 0, fixedCostMonthly: 0, taxRatePct: 0, months: 2 });
  const rows = project(cfg);
  close(rows[0].newUnits, 100); // the starting base is acquired too
  close(rows[0].acquisitionCost, 500);
  close(rows[1].newUnits, 10);
  close(rows[1].acquisitionCost, 50);
});

test('tax applies only to positive operating profit', () => {
  const loss = normalize({ price: 10, units: 1, variableCostPct: 0, fixedCostMonthly: 1000, taxRatePct: 50 });
  const row = monthRow(loss, 1, 0);
  assert.ok(row.operatingProfit < 0);
  assert.equal(row.tax, 0);
  close(row.netProfit, row.operatingProfit);
});

test('contribution per unit subtracts growth-funded CAC', () => {
  const cfg = normalize({ mode: MODE_RECURRING, price: 100, variableCostPct: 20, growthPct: 10, acqCostPerUnit: 30 });
  close(contributionPerUnit(cfg), 100 * 0.8 - 30 * 0.1);
});

test('break-even units produce exactly zero operating profit', () => {
  const cfg = normalize({ mode: MODE_FLOW, price: 50, variableCostPct: 20, acqCostPerUnit: 5, fixedCostMonthly: 1000, taxRatePct: 0, growthPct: 0 });
  const res = simulate({ ...cfg, months: 1 });
  assert.ok(res.breakEvenUnits !== null);
  close(res.breakEvenUnits, 1000 / (50 * 0.8 - 5));
  close(monthRow(cfg, res.breakEvenUnits, 0).operatingProfit, 0, 1e-9);
});

test('break-even is null when every unit loses money', () => {
  const res = simulate({ mode: MODE_FLOW, price: 5, variableCostPct: 90, acqCostPerUnit: 3, fixedCostMonthly: 100 });
  assert.equal(res.breakEvenUnits, null);
  assert.ok(res.warnings.some((w) => /loses money/.test(w)));
});

test('startup cost is charged before month 1 and delays payback', () => {
  const base = { mode: MODE_FLOW, price: 100, units: 5, growthPct: 0, variableCostPct: 0, fixedCostMonthly: 0, acqCostPerUnit: 0, taxRatePct: 0, months: 6 };
  const free = simulate({ ...base, startupCost: 0 });
  assert.equal(free.monthsToPayback, 1);
  const costly = simulate({ ...base, startupCost: 1000 });
  close(costly.series[0].cumulativeNet, 500 - 1000);
  assert.equal(costly.monthsToPayback, 2);
  assert.equal(costly.peakInvestment, -500);
});

test('effective hourly rate divides annual net by annual hours', () => {
  const res = simulate({ mode: MODE_FLOW, price: 100, units: 10, growthPct: 0, variableCostPct: 0, fixedCostMonthly: 0, acqCostPerUnit: 0, taxRatePct: 0, hoursPerWeek: 10, months: 12 });
  close(res.annualNet, 12000);
  close(res.effectiveHourlyRate, 12000 / 520);
});

test('sensitivities rank price above volume at equal 10% effort', () => {
  const res = simulate({ mode: MODE_FLOW, price: 200, units: 10, growthPct: 0, variableCostPct: 40, fixedCostMonthly: 200, acqCostPerUnit: 10, taxRatePct: 0 });
  const rank = res.sensitivities.filter((s) => s.effective).map((s) => s.id);
  assert.equal(rank[0], 'price');
  assert.ok(rank.includes('units'));
});

test('sensitivities are sorted by descending annual impact', () => {
  const cfg = normalize({ mode: MODE_RECURRING, price: 60, units: 50, growthPct: 6, churnPct: 3, variableCostPct: 20, fixedCostMonthly: 400, acqCostPerUnit: 10, taxRatePct: 25 });
  const list = sensitivities(cfg, 0).filter((s) => s.effective);
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].annualNetDelta >= list[i].annualNetDelta);
  }
});

test('sensitivities flag zero-valued levers instead of inventing a number', () => {
  const cfg = normalize({ churnPct: 0, acqCostPerUnit: 0 });
  const list = sensitivities(cfg, 100);
  const churn = list.find((s) => s.id === 'churnPct');
  assert.equal(churn.effective, false);
  assert.equal(churn.annualNetDelta, 0);
});


test('goalSeek units actually hit the target at steady state', () => {
  const cfg = normalize({ mode: MODE_FLOW, price: 50, units: 20, growthPct: 0, variableCostPct: 20, fixedCostMonthly: 500, acqCostPerUnit: 5, taxRatePct: 25 });
  const goal = goalSeek(cfg, 3000);
  assert.ok(goal.requiredUnits > 0);
  const res = simulate({ ...cfg, units: goal.requiredUnits, months: 1 });
  close(res.steadyState.netProfit, 3000, 0.01);
});

test('goalSeek price actually hits the target at steady state', () => {
  const cfg = normalize({ mode: MODE_FLOW, price: 20, units: 30, growthPct: 0, variableCostPct: 20, fixedCostMonthly: 400, acqCostPerUnit: 5, taxRatePct: 25 });
  const goal = goalSeek(cfg, 2500);
  assert.ok(goal.requiredPrice > 0);
  const res = simulate({ ...cfg, price: goal.requiredPrice, months: 1 });
  close(res.steadyState.netProfit, 2500, 0.01);
});

test('goalSeek reports unreachable when contribution is negative', () => {
  const res = simulate({ mode: MODE_FLOW, price: 5, variableCostPct: 95, acqCostPerUnit: 1, fixedCostMonthly: 50 });
  const goal = goalSeek(res.config, 1000);
  assert.equal(goal.reachable, false);
  assert.equal(goal.requiredUnits, null);
  assert.match(goal.note, /loses money/);
});

test('warns when churn cancels growth', () => {
  const res = simulate({ mode: MODE_RECURRING, churnPct: 8, growthPct: 8, months: 6 });
  assert.ok(res.warnings.some((w) => /Churn/.test(w)));
});

test('warns when the model never becomes profitable', () => {
  const res = simulate({ mode: MODE_FLOW, price: 10, units: 2, variableCostPct: 0, fixedCostMonthly: 5000, months: 3 });
  assert.ok(res.warnings.some((w) => /never reaches monthly profitability/.test(w)));
});

test('monthsToBreakEven reports the first profitable month', () => {
  const never = simulate({ mode: MODE_FLOW, price: 100, units: 1, growthPct: 0, variableCostPct: 0, fixedCostMonthly: 1000, acqCostPerUnit: 0, taxRatePct: 0, months: 24 });
  assert.equal(never.monthsToBreakEven, null);
  // 5 units growing 25%/mo against $1000 fixed: crosses zero in month 5.
  const later = simulate({ mode: MODE_FLOW, price: 100, units: 5, growthPct: 25, variableCostPct: 0, fixedCostMonthly: 1000, acqCostPerUnit: 0, taxRatePct: 0, months: 12 });
  assert.equal(later.monthsToBreakEven, 5);
  const atOnce = simulate({ mode: MODE_FLOW, price: 100, units: 15, growthPct: 0, variableCostPct: 0, fixedCostMonthly: 1000, acqCostPerUnit: 0, taxRatePct: 0, months: 12 });
  assert.equal(atOnce.monthsToBreakEven, 1);
});

test('simulate result is serialisable JSON (no cycles, no functions)', () => {
  const res = simulate({ mode: MODE_RECURRING, months: 6 });
  const round = JSON.parse(JSON.stringify(res));
  assert.equal(round.series.length, 6);
  assert.equal(typeof round.steadyState.netProfit, 'number');
});

test('long horizon stays finite and stable', () => {
  const res = simulate({ mode: MODE_RECURRING, months: 600, growthPct: 3, churnPct: 3, price: 20, units: 100 });
  assert.ok(Number.isFinite(res.annualNet));
  assert.ok(Number.isFinite(res.steadyState.units));
});

