import { createHmac, timingSafeEqual } from 'node:crypto';

// A license key is a signed capability, not a secret you look up in a table.
// The app can therefore verify a key offline, in any process, with no database
// round trip -- which is what makes it usable inside someone else's product.
//
//   MINT.<base64url(payload)>.<base64url(hmac-sha256(payload segment))>

const PREFIX = 'MINT';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(str, 'base64url');

function sign(segment, secret) {
  return createHmac('sha256', secret).update(segment).digest();
}

export function issueLicense({
  productId,
  orderId,
  customerId,
  email = null,
  seats = 1,
  days = null,
  secret,
  now = new Date(),
}) {
  if (!secret) throw new Error('license signing secret required');
  const issuedAt = Math.floor(now.getTime() / 1000);
  const payload = {
    v: 1,
    sub: orderId,
    prd: productId,
    cus: customerId,
    email,
    seats,
    iat: issuedAt,
    exp: days ? issuedAt + days * 86400 : null,
  };
  // The signed segment is the encoded payload itself, so verification never
  // has to re-serialise an object and hope JSON round-trips byte-for-byte.
  const segment = b64u(JSON.stringify(payload));
  return `${PREFIX}.${segment}.${b64u(sign(segment, secret))}`;
}

/**
 * Verify a key -> { valid, reason, payload }.
 * Never throws on malformed input: a license check runs against hostile input
 * by definition, since anyone can POST a string at a verify endpoint.
 */
export function verifyLicense(key, { secret, now = new Date() } = {}) {
  const fail = (reason) => ({ valid: false, reason, payload: null });
  if (!secret) return fail('no_secret');
  if (typeof key !== 'string') return fail('not_a_string');

  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return fail('malformed');

  let payload;
  let provided;
  try {
    payload = JSON.parse(unb64u(parts[1]).toString('utf8'));
    provided = unb64u(parts[2]);
  } catch {
    return fail('malformed');
  }

  const expected = sign(parts[1], secret);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return fail('bad_signature');
  }
  if (payload.exp && payload.exp * 1000 < now.getTime()) return fail('expired');
  return { valid: true, reason: 'ok', payload };
}
