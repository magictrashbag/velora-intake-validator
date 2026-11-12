import type { Currency } from './money.ts';
import { MoneyError } from './money.ts';

/**
 * Every conversion settles through ONE crypto settlement asset. There are no direct fiat<->fiat
 * legs (e.g. USD->VES is always USD->USDC->VES). The database enforces the same rule on the
 * ledger (db/migrations/002_crypto_compliance.sql), so code that skips this module still can't
 * post a non-routed conversion.
 *
 * NOTE: routing through crypto does not reduce regulatory obligations. It adds crypto-specific
 * ones (address screening, Travel Rule, stablecoin eligibility). See docs/COMPLIANCE.md.
 */
export const SETTLEMENT_ASSET = 'USDC' as const satisfies Currency;

export interface ConversionLeg { sell: Currency; buy: Currency }

export function planConversion(sell: Currency, buy: Currency): ConversionLeg[] {
  if (sell === buy) throw new MoneyError('cannot convert a currency to itself');
  if (sell === SETTLEMENT_ASSET || buy === SETTLEMENT_ASSET) return [{ sell, buy }];
  return [{ sell, buy: SETTLEMENT_ASSET }, { sell: SETTLEMENT_ASSET, buy }];
}

/** A set of currencies touched by ONE ledger transaction is valid iff it is a single
 *  currency, or exactly two currencies one of which is the settlement asset. */
export function isRoutedLeg(currencies: Iterable<Currency>): boolean {
  const s = new Set(currencies);
  if (s.size <= 1) return true;
  return s.size === 2 && s.has(SETTLEMENT_ASSET);
}
