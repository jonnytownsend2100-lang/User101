import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, formatCents, applyBps, sumCents, ratioBps, assertCents } from '../src/money.mjs';

test('toCents parses human input exactly', () => {
  assert.equal(toCents('123.45'), 12345);
  assert.equal(toCents(123.4), 12340);
  assert.equal(toCents('$1,234.50'), 123450);
  assert.equal(toCents('0.1'), 10);
  assert.equal(toCents('0.01'), 1);
  assert.equal(toCents('42'), 4200);
  assert.equal(toCents(-5), -500);
  assert.equal(toCents('-0.99'), -99);
});

test('toCents refuses ambiguous or lossy input', () => {
  for (const bad of ['1.234', 'abc', '', '1.2.3', '12,3.4.5', undefined, null, {}, []]) {
    assert.throws(() => toCents(bad), TypeError, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => toCents(NaN), TypeError);
  assert.throws(() => toCents(Infinity), TypeError);
});

test('float inputs are rounded once, at the boundary', () => {
  // 0.1 + 0.2 in dollars must not become 30.000000000000004 cents
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents(19.99 * 3), 5997);
});

test('formatCents renders minor units without float drift', () => {
  assert.equal(formatCents(12345), '$123.45');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(100000000), '$1,000,000.00');
  assert.equal(formatCents(-12345), '-$123.45');
  assert.equal(formatCents(1000, 'EUR'), '\u20ac10.00');
  assert.equal(formatCents(1000, 'SEK'), '10.00 SEK');
  assert.throws(() => formatCents(12.5), TypeError);
});

test('applyBps is integer maths in basis points', () => {
  assert.equal(applyBps(1250000, 150), 18750); // 1.5% of $12,500.00
  assert.equal(applyBps(100, 0), 0);
  assert.equal(applyBps(333, 150), 5); // rounds, never truncates to 4.995
  assert.throws(() => applyBps(100, -1), TypeError);
});

test('sumCents and ratioBps guard the edges', () => {
  assert.equal(sumCents([1, 2, 3]), 6);
  assert.equal(sumCents([]), 0);
  assert.throws(() => sumCents([1, 1.5]), TypeError);
  assert.equal(ratioBps(50, 200), 2500);
  assert.equal(ratioBps(1, 0), 0); // no divide-by-zero NaN leaking into a report
});

test('assertCents rejects floats and unsafe integers', () => {
  assert.doesNotThrow(() => assertCents(0));
  assert.throws(() => assertCents(1.5), TypeError);
  assert.throws(() => assertCents('100'), TypeError);
  assert.throws(() => assertCents(Number.MAX_VALUE), TypeError);
});
