// Money is stored as integer minor units (cents). Floats are never used for
// balances -- 0.1 + 0.2 !== 0.3 and a ledger that drifts by a cent is a ledger
// nobody trusts.

export const CURRENCY_MINOR = { usd: 100, eur: 100, gbp: 100, jpy: 1 };

/** Convert a human amount ("19.99", 19.99) into integer minor units. */
export function toMinor(amount, currency = 'usd') {
  const scale = CURRENCY_MINOR[currency.toLowerCase()] ?? 100;
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new TypeError(`not a number: ${amount}`);
  return Math.round(n * scale);
}

/** Convert integer minor units back to a human number. */
export function toMajor(minor, currency = 'usd') {
  const scale = CURRENCY_MINOR[currency.toLowerCase()] ?? 100;
  return minor / scale;
}

/** Format minor units for display. */
export function format(minor, currency = 'usd') {
  const scale = CURRENCY_MINOR[currency.toLowerCase()] ?? 100;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / scale);
  const frac = String(abs % scale).padStart(String(scale).length - 1, '0');
  const symbol = { usd: '$', eur: '\u20ac', gbp: '\u00a3', jpy: '\u00a5' }[currency.toLowerCase()] ?? '';
  return scale === 1 ? `${sign}${symbol}${whole}` : `${sign}${symbol}${whole}.${frac}`;
}

/**
 * Provider fee in minor units. `bps` is basis points (290 = 2.90%),
 * `fixed` is minor units per charge. This is the number that decides whether
 * a price is actually profitable, so it is modelled explicitly, never guessed.
 */
export function providerFee(amountMinor, { bps = 0, fixed = 0 } = {}) {
  return Math.round((amountMinor * bps) / 10000) + fixed;
}
