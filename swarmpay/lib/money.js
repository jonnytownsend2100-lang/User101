/**
 * Money math. Two rules, and everything else follows from them.
 *
 * 1. **Never use floats for money.** Internally we carry *mills*: integer
 *    1/1000ths of a cent. A price like "$6.00 per 1,000 tasks" is 6 cents per
 *    task = 6,000 mills per task, exactly. Doing that in dollars with float64
 *    gives 0.006000000000000001, and invoices that don't reconcile.
 *
 * 2. **Round exactly once, at the boundary, half away from zero.** Rounding in
 *    the middle of a computation is how you lose a cent per customer per month
 *    and then can't explain the books to anyone.
 *
 * Every function here asserts its inputs are safe integers, because the one
 * failure mode worse than a rounding bug is a silent `NaN` on an invoice.
 */

export const MILLS_PER_CENT = 1000;

export function assertInteger(n, what = 'value') {
  if (!Number.isSafeInteger(n)) {
    throw new TypeError(`${what} must be a safe integer, got ${JSON.stringify(n)}`);
  }
  return n;
}

/**
 * Round half away from zero. `Math.round` is half *up* (toward +Infinity),
 * which turns -0.5 into -0 and quietly biases credits and refunds toward the
 * house. That is the kind of bug that shows up in a reconciliation six months
 * later.
 */
export function roundHalfAwayFromZero(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new TypeError(`cannot round ${JSON.stringify(x)}`);
  }
  const sign = x < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(x)) || 0; // `|| 0` normalises -0
}

export function centsToMills(cents) {
  assertInteger(cents, 'cents');
  return cents * MILLS_PER_CENT;
}

/** The only place mills become cents. */
export function millsToCents(mills) {
  assertInteger(mills, 'mills');
  return roundHalfAwayFromZero(mills / MILLS_PER_CENT);
}

export function sumMills(values) {
  let total = 0;
  for (const v of values) {
    assertInteger(v, 'mills');
    total += v;
    assertInteger(total, 'running sum of mills');
  }
  return total;
}

export function sumCents(values) {
  let total = 0;
  for (const v of values) {
    assertInteger(v, 'cents');
    total += v;
    assertInteger(total, 'running sum of cents');
  }
  return total;
}

export function formatUsd(cents) {
  assertInteger(cents, 'cents');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatMillsAsUsd(mills) {
  return formatUsd(millsToCents(mills));
}

/**
 * Exact pro-rata of `amountMills` for the slice [atMs, periodEndMs) of a
 * period. BigInt, not float: multiplying a monthly price by a millisecond
 * fraction in float64 loses cents once the invoice gets large, and "we prorate"
 * is exactly the code path nobody re-tests.
 *
 * Returns 0 when the period is already over, the full amount when `atMs` is at
 * or before the period start.
 */
export function prorateMills(amountMills, { periodStartMs, periodEndMs, atMs }) {
  assertInteger(amountMills, 'amountMills');
  assertInteger(periodStartMs, 'periodStartMs');
  assertInteger(periodEndMs, 'periodEndMs');
  assertInteger(atMs, 'atMs');
  const total = periodEndMs - periodStartMs;
  if (total <= 0) throw new RangeError('periodEndMs must be after periodStartMs');

  const remaining = Math.min(Math.max(periodEndMs - atMs, 0), total);
  const numerator = BigInt(amountMills) * BigInt(remaining);
  const denominator = BigInt(total);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  // half away from zero, in exact integer arithmetic
  if (remainder * 2n >= denominator) quotient += quotient < 0n ? -1n : 1n;
  return Number(quotient);
}

/**
 * Graduated (banded) pricing, split into the bands themselves.
 *
 * Each band is priced by its own rate, so "first 200,000 at $4/1k, then $3/1k"
 * is data, not code. Returning the *bands* rather than just a total is what lets
 * an invoice show why the number is what it is; one opaque line item is how
 * billing disputes start.
 *
 *   tiers = [{ upTo: 200_000, millsPerUnit: 400 }, { upTo: null, millsPerUnit: 300 }]
 *
 * `upTo` is the cumulative unit count at which the band ends; `null` means
 * open-ended. A tier list without an open-ended last band throws rather than
 * silently billing zero for the overflow.
 */
export function graduatedBands(units, tiers) {
  assertInteger(units, 'units');
  if (units < 0) throw new RangeError('units must be >= 0');
  if (units === 0) return [];
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new RangeError('no pricing tiers supplied for billable units');
  }

  const bands = [];
  let previousCeiling = 0;
  let billed = 0;

  for (const [index, tier] of tiers.entries()) {
    const ceiling = tier.upTo ?? Infinity;
    if (ceiling <= previousCeiling) {
      throw new RangeError(`tier ${index} ceiling ${ceiling} does not exceed previous ${previousCeiling}`);
    }
    assertInteger(tier.millsPerUnit, `tier ${index} millsPerUnit`);

    const bandUnits = Math.min(units, ceiling) - previousCeiling;
    if (bandUnits > 0) {
      const amountMills = bandUnits * tier.millsPerUnit;
      assertInteger(amountMills, `band ${index} amount (mills)`);
      bands.push({ units: bandUnits, millsPerUnit: tier.millsPerUnit, amountMills });
      billed += bandUnits;
    }
    previousCeiling = ceiling;
    if (units <= ceiling) break;
  }

  if (billed !== units) {
    throw new RangeError(`${units - billed} units fall outside the last tier; add an open-ended tier`);
  }
  return bands;
}

/** Total graduated cost in mills. Defined as the sum of the bands, so there is one implementation. */
export function graduatedMills(units, tiers) {
  return sumMills(graduatedBands(units, tiers).map((band) => band.amountMills));
}

