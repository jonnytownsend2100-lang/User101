import test from 'node:test';
import assert from 'node:assert/strict';
import { format, providerFee, toMajor, toMinor } from '../lib/money.js';

test('toMinor converts without float drift', () => {
  assert.equal(toMinor(19.99), 1999);
  assert.equal(toMinor('0.1') + toMinor('0.2'), toMinor('0.3'));
  assert.equal(toMinor(29), 2900);
});

test('toMinor respects zero-decimal currencies', () => {
  assert.equal(toMinor(1200, 'jpy'), 1200);
  assert.equal(toMajor(1200, 'jpy'), 1200);
  assert.equal(format(1200, 'jpy'), '\u00a51200');
});

test('format renders minor units as currency', () => {
  assert.equal(format(1999), '$19.99');
  assert.equal(format(0), '$0.00');
  assert.equal(format(-500), '-$5.00');
  assert.equal(format(100000), '$1000.00');
});

test('providerFee models bps + fixed', () => {
  assert.equal(providerFee(2900, { bps: 290, fixed: 30 }), 114); // 2.9% of $29 + $0.30
  assert.equal(providerFee(2900, { bps: 0, fixed: 0 }), 0);
});

test('toMinor rejects non-numbers', () => {
  assert.throws(() => toMinor('free'), TypeError);
});
