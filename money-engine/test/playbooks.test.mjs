import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYBOOKS, playbookById } from '../src/playbooks.mjs';
import { simulate, normalize } from '../src/engine.mjs';

test('playbook ids are unique', () => {
  const ids = PLAYBOOKS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every playbook is complete and internally consistent', () => {
  for (const p of PLAYBOOKS) {
    assert.ok(p.name && p.summary, `${p.id} needs a name and summary`);
    assert.ok(p.keyRisk && p.whyMostFail, `${p.id} must state its risk honestly`);
    assert.equal(p.firstThreeSteps.length, 3, `${p.id} needs exactly three first steps`);
    assert.ok(p.startupCostRange[0] <= p.startupCostRange[1], `${p.id} startup range inverted`);
    assert.ok(p.monthsToFirstDollar[0] <= p.monthsToFirstDollar[1], `${p.id} time range inverted`);
    assert.ok(p.realisticMonthlyNetRange[0] <= p.realisticMonthlyNetRange[1], `${p.id} net range inverted`);
    assert.ok(p.hoursPerWeek[0] <= p.hoursPerWeek[1], `${p.id} hours range inverted`);
    assert.ok(p.difficulty >= 1 && p.difficulty <= 5, `${p.id} difficulty out of range`);
  }
});

test('every playbook preset normalises and simulates without error', () => {
  for (const p of PLAYBOOKS) {
    const res = simulate({ ...p.preset, months: 24 });
    assert.equal(res.series.length, 24, `${p.id} produced the wrong horizon`);
    assert.ok(Number.isFinite(res.annualNet), `${p.id} annual net is not finite`);
    assert.equal(res.sensitivities.length > 0, true, `${p.id} produced no levers`);
  }
});

test('preset mode matches the playbook mode', () => {
  for (const p of PLAYBOOKS) {
    assert.equal(p.preset.mode, p.mode, `${p.id} preset mode disagrees with playbook mode`);
  }
});

test('flow playbooks do not leak churn into their preset', () => {
  for (const p of PLAYBOOKS.filter((x) => x.mode === 'flow')) {
    assert.equal(normalize(p.preset).churnPct, 0, `${p.id} flow preset carries churn`);
  }
});

test('playbookById returns null for unknown ids rather than throwing', () => {
  assert.equal(playbookById('nope'), null);
  assert.equal(playbookById('micro-saas').name, 'Micro-SaaS');
});

test('net ranges stay physically plausible for a part-time operator', () => {
  for (const p of PLAYBOOKS) {
    const [lo, hi] = p.realisticMonthlyNetRange;
    assert.ok(lo >= 0, `${p.id} claims negative floor net`);
    assert.ok(hi < 25000, `${p.id} advertises an implausible ceiling`);
  }
});
