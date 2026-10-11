import test from 'node:test';
import assert from 'node:assert/strict';
import { issueLicense, verifyLicense } from '../lib/license.js';

const secret = 'test-secret';
const base = { productId: 'prd_1', orderId: 'ord_1', customerId: 'cus_1', secret };

test('a freshly issued key verifies and carries its claims', () => {
  const key = issueLicense(base);
  assert.match(key, /^MINT\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const result = verifyLicense(key, { secret });
  assert.equal(result.valid, true);
  assert.equal(result.payload.sub, 'ord_1');
  assert.equal(result.payload.seats, 1);
});

test('a tampered payload fails the signature check', () => {
  const key = issueLicense(base);
  const [prefix, , sig] = key.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, sub: 'ord_evil', seats: 999 })).toString('base64url');
  const result = verifyLicense(`${prefix}.${forged}.${sig}`, { secret });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'bad_signature');
});

test('another secret cannot verify the key', () => {
  const key = issueLicense(base);
  assert.equal(verifyLicense(key, { secret: 'not-the-secret' }).valid, false);
});

test('expiry is enforced', () => {
  const issued = new Date('2024-01-01T00:00:00Z');
  const key = issueLicense({ ...base, days: 30, now: issued });
  assert.equal(verifyLicense(key, { secret, now: new Date('2024-01-20T00:00:00Z') }).valid, true);
  const late = verifyLicense(key, { secret, now: new Date('2024-03-01T00:00:00Z') });
  assert.equal(late.valid, false);
  assert.equal(late.reason, 'expired');
});

test('malformed input never throws', () => {
  for (const bad of [null, 42, '', 'MINT', 'MINT.a', 'NOPE.a.b', 'MINT.!!!.???']) {
    const result = verifyLicense(bad, { secret });
    assert.equal(result.valid, false);
  }
});

test('issuing without a secret is refused', () => {
  assert.throws(() => issueLicense({ ...base, secret: undefined }), /secret/);
});
