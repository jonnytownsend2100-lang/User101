import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunner, RUNNER_RATES, RATES_META } from '../src/rates.js';
import {
  jobBillableMinutes, priceJob, summarizeJobs, projectMonthEnd,
} from '../src/billing.js';

const iso = (s) => new Date(s).toISOString();
const job = (labels, seconds, extra = {}) => ({
  labels,
  started_at: iso('2026-01-01T00:00:00Z'),
  completed_at: iso(new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString()),
  ...extra,
});

test('rate table is transcribed with provenance and no duplicate SKUs', () => {
  assert.equal(RATES_META.currency, 'USD');
  assert.match(RATES_META.lastVerified, /^\d{4}-\d{2}-\d{2}$/);
  const skus = RUNNER_RATES.map((r) => r.sku);
  assert.equal(new Set(skus).size, skus.length, 'duplicate SKU');
  for (const r of RUNNER_RATES) {
    assert.ok(r.perMinute > 0, `${r.sku} has non-positive price`);
    assert.ok(['linux', 'windows', 'macos'].includes(r.os));
  }
});

test('standard labels map to documented SKUs exactly', () => {
  assert.equal(resolveRunner(['ubuntu-latest']).sku, 'actions_linux');
  assert.equal(resolveRunner(['ubuntu-22.04']).sku, 'actions_linux');
  assert.equal(resolveRunner(['ubuntu-slim']).sku, 'actions_linux_slim');
  assert.equal(resolveRunner(['windows-2022']).sku, 'actions_windows');
  assert.equal(resolveRunner(['macos-14']).sku, 'actions_macos');
  assert.equal(resolveRunner(['ubuntu-latest']).confidence, 'exact');
});

test('larger runners are parsed to the right price', () => {
  assert.equal(resolveRunner(['ubuntu-latest-16-core']).perMinute, 0.042);
  assert.equal(resolveRunner(['windows-latest-8-core']).perMinute, 0.042);
  assert.equal(resolveRunner(['ubuntu-22.04-arm-8-core']).perMinute, 0.014);
  assert.equal(resolveRunner(['macos-14-xlarge']).perMinute, 0.102);
  assert.equal(resolveRunner(['macos-13-large']).perMinute, 0.077);
  assert.equal(resolveRunner(['ubuntu-latest-16-core']).kind, 'larger');
});

test('self-hosted is priced at zero and never counted as billable compute', () => {
  const r = resolveRunner(['self-hosted', 'linux', 'x64']);
  assert.equal(r.perMinute, 0);
  assert.equal(r.kind, 'self-hosted');
  const s = summarizeJobs([job(['self-hosted'], 3600)]);
  assert.equal(s.grossCostUsd, 0);
  assert.equal(s.selfHostedJobs, 1);
});

test('unpriceable runners are reported, never silently guessed', () => {
  const r = resolveRunner(['acme-internal-runner']);
  assert.equal(r.perMinute, null);
  assert.equal(r.confidence, 'unknown');
  const s = summarizeJobs([job(['acme-internal-runner'], 600)]);
  assert.equal(s.unpricedJobs, 1);
  assert.equal(s.grossCostUsd, 0);
});

test('minutes round up to the whole minute, minimum one minute', () => {
  assert.equal(jobBillableMinutes(job(['ubuntu-latest'], 1)), 1);
  assert.equal(jobBillableMinutes(job(['ubuntu-latest'], 60)), 1);
  assert.equal(jobBillableMinutes(job(['ubuntu-latest'], 61)), 2);
  assert.equal(jobBillableMinutes(job(['ubuntu-latest'], 600)), 10);
  assert.equal(jobBillableMinutes({ labels: [] }), null);
});

test('cost matches hand-computed GitHub rates', () => {
  // 10 minutes on Linux 2-core at $0.006 = $0.06
  assert.equal(priceJob(job(['ubuntu-latest'], 600)).costUsd, 0.06);
  // 10 minutes on macOS at $0.062 = $0.62 -- macOS is the budget killer
  assert.equal(priceJob(job(['macos-14'], 600)).costUsd, 0.62);
  // 10 minutes on Windows 2-core at $0.010 = $0.10
  assert.equal(priceJob(job(['windows-latest'], 600)).costUsd, 0.10);
});

test('summarizeJobs splits standard vs larger and totals by OS', () => {
  const s = summarizeJobs([
    job(['ubuntu-latest'], 600),        // $0.06
    job(['macos-14'], 600),             // $0.62
    job(['ubuntu-latest-16-core'], 600), // $0.42 larger
  ]);
  assert.equal(s.grossCostUsd, 1.10);
  assert.equal(s.standardCostUsd, 0.68);
  assert.equal(s.largerCostUsd, 0.42);
  assert.equal(s.byOs.linux.minutes, 20);
  assert.equal(s.byOs.linux.jobs, 2);
  assert.equal(s.byOs.macos.minutes, 10);
});

test('included minutes: under the allowance the standard cost is credited', () => {
  const s = summarizeJobs([job(['ubuntu-latest'], 600)], { plan: 'free' });
  assert.equal(s.standardMultipliedMinutes, 10);
  assert.equal(s.includedMinutes, 2000);
  assert.equal(s.allowanceCreditUsd, 0.06);
  assert.equal(s.estimatedInvoiceUsd, 0);
});

test('included minutes: macOS burns the allowance 10x faster', () => {
  const s = summarizeJobs([job(['macos-14'], 600)], { plan: 'free' });
  assert.equal(s.standardMultipliedMinutes, 100);
  assert.equal(s.estimatedInvoiceUsd, 0);
});

test('over the allowance, the uncovered portion is estimated', () => {
  // 400 Linux minutes on a 2000-minute allowance: 2000 covered, so all covered
  const under = summarizeJobs([job(['ubuntu-latest'], 400 * 60)], { plan: 'free' });
  assert.equal(under.estimatedInvoiceUsd, 0);
  // 4000 minutes: half the allowance is exceeded -> half the cost remains
  const over = summarizeJobs([job(['ubuntu-latest'], 4000 * 60)], { plan: 'free' });
  assert.equal(over.standardCostUsd, 24);
  assert.equal(over.estimatedInvoiceUsd, 12);
});

test('larger runners never draw on included minutes', () => {
  const s = summarizeJobs([job(['ubuntu-latest-16-core'], 600)], { plan: 'enterprise' });
  assert.equal(s.standardMultipliedMinutes, 0);
  assert.equal(s.allowanceCreditUsd, 0);
  assert.equal(s.estimatedInvoiceUsd, 0.42);
});

test('month-end projection is linear and labelled with the sample point', () => {
  const p = projectMonthEnd(300, new Date('2026-01-10T12:00:00Z'));
  assert.equal(p.day, 10);
  assert.equal(p.daysInMonth, 31);
  assert.equal(p.projectedUsd, 930);
});
