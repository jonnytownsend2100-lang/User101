/**
 * All money in this app is integer minor units (cents). Never floats.
 *
 * `0.1 + 0.2 !== 0.3` is not a rounding curiosity, it is a wrong invoice. The
 * only place a float is allowed is the boundary where a human types "123.45",
 * and it is converted to an integer immediately.
 */

/** @typedef {number} Cents integer minor units */

const CURRENCY_SYMBOLS = { USD: '$', EUR: '\u20ac', GBP: '\u00a3', JPY: '\u00a5' };

/**
 * Parse a human-entered amount into integer cents.
 * Accepts 123.45, "123.45", "$1,234.5", 123.4 -> 12340.
 * Rejects anything with more than 2 decimals, or non-finite/NaN input.
 * @param {number|string} amount
 * @returns {Cents}
 */
export function toCents(amount) {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) throw new TypeError(`amount must be finite, got ${amount}`);
    return Math.round(amount * 100);
  }
  if (typeof amount === 'string') {
    const cleaned = amount.trim().replace(/[$€£¥,\s]/g, '');
    if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
      throw new TypeError(`cannot parse amount: ${JSON.stringify(amount)}`);
    }
    const negative = cleaned.startsWith('-');
    const [whole, frac = ''] = cleaned.replace('-', '').split('.');
    const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
    if (!Number.isSafeInteger(cents)) throw new TypeError(`amount out of range: ${amount}`);
    return negative ? -cents : cents;
  }
  throw new TypeError(`amount must be a number or string, got ${typeof amount}`);
}

/** Render integer cents for humans. @param {Cents} cents */
export function formatCents(cents, currency = 'USD') {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const body = `${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  const symbol = CURRENCY_SYMBOLS[currency];
  const rendered = symbol ? `${symbol}${body}` : `${body} ${currency}`;
  return negative ? `-${rendered}` : rendered;
}

/** Basis points of an amount, rounded half-up in integer space. @param {Cents} cents @param {number} bps */
export function applyBps(cents, bps) {
  assertCents(cents);
  if (!Number.isFinite(bps) || bps < 0) throw new TypeError(`bps must be a non-negative number, got ${bps}`);
  return Math.round((cents * bps) / 10_000);
}

/** @param {Cents[]} list */
export function sumCents(list) {
  let total = 0;
  for (const c of list) {
    assertCents(c);
    total += c;
  }
  return total;
}

/** Throw on anything that is not an integer number of cents. @param {unknown} value */
export function assertCents(value) {
  if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new TypeError(`expected integer cents, got ${JSON.stringify(value)}`);
  }
}

/** Money ratio in basis points, guarded against divide-by-zero. Returns 0..10000+ */
export function ratioBps(numerator, denominator) {
  assertCents(numerator);
  assertCents(denominator);
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000);
}
