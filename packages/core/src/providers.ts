/**
 * Boundaries to LICENSED partners. Puente never custodies crypto keys, issues cards, or
 * performs identity verification itself; those are regulated activities done by partners
 * under their licenses. Each interface has a mock in apps/api/src/providers/mock.ts.
 */
import type { Currency } from './money.ts';
import type { AddressRisk, KycTier, ScreeningResult } from './compliance.ts';
import type { Network } from './crypto.ts';

export interface KycProvider {
  /** Start a hosted verification flow; returns a URL/session for the partner's SDK. */
  startVerification(userId: string, targetTier: KycTier): Promise<{ sessionId: string; url: string }>;
}

export interface SanctionsScreener {
  /** Screen a person against OFAC SDN + other lists. Called at onboarding and periodically. */
  screenPerson(p: { fullName: string; dateOfBirth?: string; country?: string }): Promise<{
    result: ScreeningResult;
    providerRef: string;
  }>;
  /**
   * Screen a blockchain address: exact match against OFAC SDN digital-currency addresses
   * (OFAC FAQ 594: exact match only) PLUS blockchain-analytics exposure scoring, because
   * OFAC states its address listings are not exhaustive (FAQ 562).
   */
  screenAddress(network: Network, address: string): Promise<{ risk: AddressRisk; providerRef: string }>;
}

export interface FxRateProvider {
  /** Mid-market rate: quote units per 1 base unit, as an exact decimal string. */
  midRate(base: Currency, quote: Currency): Promise<{ rate: string; source: string; asOf: Date }>;
}

export interface CustodyProvider {
  /** Omnibus on-chain stablecoin custody. Internal transfers never touch the chain. */
  createDepositAddress(userId: string, network: Network): Promise<string>;
  withdraw(req: { idempotencyKey: string; network: Network; address: string; amountMinor: bigint }): Promise<{ providerRef: string }>;
}

export interface BolivarPayoutProvider {
  /** Pay out bolívares via Pago Móvil / bank transfer through a licensed local partner. */
  payout(req: { idempotencyKey: string; bankCode: string; phoneOrAccount: string; nationalId: string; amountMinor: bigint }): Promise<{ providerRef: string }>;
}

export interface CardIssuer {
  /** Card data (PAN/CVV) stays with the issuer-processor; Puente only stores the token. */
  issueVirtualCard(userId: string): Promise<{ cardToken: string; last4: string }>;
}
