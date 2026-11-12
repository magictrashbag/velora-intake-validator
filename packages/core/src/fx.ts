import { CURRENCIES, type Currency, MoneyError, type Money } from './money.ts';

/**
 * An exchange rate as an exact rational: `num / den` units of `quote` per 1 unit of `base`.
 * Built from a decimal string so "36.4512" is exact, never a float.
 */
export interface Rate {
  base: Currency;
  quote: Currency;
  num: bigint;
  den: bigint;
}

export function parseRate(base: Currency, quote: Currency, decimal: string): Rate {
  const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(decimal);
  if (!m) throw new MoneyError(`invalid rate "${decimal}"`);
  const frac = m[2] ?? '';
  const num = BigInt(m[1]! + frac);
  if (num === 0n) throw new MoneyError('rate must be > 0');
  return { base, quote, num, den: 10n ** BigInt(frac.length) };
}

/** Apply a spread in basis points against the customer (rate gets worse for them). */
export function applySpreadBps(rate: Rate, bps: number, customerSells: 'base' | 'quote'): Rate {
  if (!Number.isInteger(bps) || bps < 0 || bps > 2000) throw new MoneyError('spread out of range');
  const b = BigInt(bps);
  // Customer selling base receives fewer quote units: multiply by (10000 - bps)/10000.
  // Customer selling quote pays more quote per base:  multiply by (10000 + bps)/10000.
  const factor = customerSells === 'base' ? 10000n - b : 10000n + b;
  return { ...rate, num: rate.num * factor, den: rate.den * 10000n };
}

/**
 * Convert `amount` using `rate`, in either direction. Result rounds DOWN, so rounding
 * dust always stays with the house side of the trade and the ledger never goes short.
 */
export function convert(amount: Money, rate: Rate): Money {
  const from = amount.currency;
  let to: Currency;
  let num: bigint;
  let den: bigint;
  if (from === rate.base) {
    to = rate.quote;
    num = rate.num;
    den = rate.den;
  } else if (from === rate.quote) {
    to = rate.base;
    num = rate.den;
    den = rate.num;
  } else {
    throw new MoneyError(`rate ${rate.base}/${rate.quote} cannot convert ${from}`);
  }
  const fs = BigInt(CURRENCIES[from].scale);
  const ts = BigInt(CURRENCIES[to].scale);
  // out_minor = in_minor / 10^fs * num/den * 10^ts
  const n = amount.minor * num * 10n ** ts;
  const d = den * 10n ** fs;
  return { currency: to, minor: n / d };
}
