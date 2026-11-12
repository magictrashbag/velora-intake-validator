/**
 * Money is ALWAYS an integer count of a currency's minor units (bigint).
 * Floats never touch balances. Parsing is strict: anything ambiguous is rejected
 * rather than rounded, because silent rounding is how ledgers drift.
 */
export const CURRENCIES = {
  /** USD-pegged stablecoin held with the custody partner; 6 decimals on-chain. */
  USDC: { scale: 6, label: 'USD' },
  /** Venezuelan bolívar (digital). */
  VES: { scale: 2, label: 'Bs.' },
  /** Fiat USD, e.g. diaspora card/ACH funding before conversion to USDC. */
  USD: { scale: 2, label: 'US$' },
} as const;

export type Currency = keyof typeof CURRENCIES;

export interface Money {
  readonly currency: Currency;
  /** Minor units. May be negative only inside ledger entries, never in user input. */
  readonly minor: bigint;
}

export function isCurrency(x: unknown): x is Currency {
  return typeof x === 'string' && Object.hasOwn(CURRENCIES, x);
}

export class MoneyError extends Error {}

const DECIMAL = /^(\d{1,15})(?:\.(\d+))?$/;
export const MAX_MINOR = 10n ** 15n;

/** Parse a user-supplied positive decimal string ("10", "10.5", "0.000001"). */
export function parseAmount(input: string, currency: Currency): Money {
  if (typeof input !== 'string') throw new MoneyError('amount must be a decimal string');
  const m = DECIMAL.exec(input.trim());
  if (!m) throw new MoneyError(`invalid amount "${input}"`);
  const scale = CURRENCIES[currency].scale;
  const frac = m[2] ?? '';
  if (frac.length > scale) {
    throw new MoneyError(`${currency} supports at most ${scale} decimal places`);
  }
  const minor = BigInt(m[1]! + frac.padEnd(scale, '0'));
  if (minor <= 0n) throw new MoneyError('amount must be greater than zero');
  // Keep every amount far inside Postgres bigint (9.2e18), including sums of many amounts.
  if (minor > MAX_MINOR) throw new MoneyError('amount too large');
  return { currency, minor };
}

export function formatAmount(money: Money, opts: { trimZeros?: boolean } = {}): string {
  const scale = CURRENCIES[money.currency].scale;
  const neg = money.minor < 0n;
  const digits = (neg ? -money.minor : money.minor).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  let frac = digits.slice(digits.length - scale);
  if (opts.trimZeros) frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Re-express an amount at another scale. Rounds DOWN (toward zero) — callers decide who absorbs dust. */
export function rescaleDown(minor: bigint, fromScale: number, toScale: number): bigint {
  if (toScale >= fromScale) return minor * 10n ** BigInt(toScale - fromScale);
  return minor / 10n ** BigInt(fromScale - toScale);
}

/**
 * USD-equivalent in cents, used for limits and thresholds. Rounds UP: when comparing against a
 * limit, a fraction of a cent must count against the customer, never in their favour.
 * USDC and USD are 1:1 by definition here.
 */
export function usdCentsEquivalent(money: Money): bigint | null {
  if (money.currency === 'USD') return money.minor;
  if (money.currency === 'USDC') return (money.minor + 9_999n) / 10_000n;
  return null; // VES needs an FX rate; see fx.ts
}
