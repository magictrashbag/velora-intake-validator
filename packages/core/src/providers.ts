/**
 * Boundaries to LICENSED partners. Puente never custodies crypto keys, issues cards, or
 * performs identity verification itself; those are regulated activities done by partners
 * under their licenses. Each interface has a mock in apps/api/src/providers/mock.ts.
 */
import type { Currency } from './money.ts';
import type { KycTier, ScreeningResult } from './compliance.ts';

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
}

export interface FxRateProvider {
  /** Mid-market rate: quote units per 1 base unit, as an exact decimal string. */
  midRate(base: Currency, quote: Currency): Promise<{ rate: string; source: string; asOf: Date }>;
}

export interface CustodyProvider {
  /** Omnibus on-chain stablecoin custody. Internal transfers never touch the chain. */
  createDepositAddress(userId: string, network: 'ethereum' | 'polygon' | 'tron' | 'solana'): Promise<string>;
  withdraw(req: { idempotencyKey: string; network: string; address: string; amountMinor: bigint }): Promise<{ providerRef: string }>;
}

export interface BolivarPayoutProvider {
  /** Pay out bolívares via Pago Móvil / bank transfer through a licensed local partner. */
  payout(req: { idempotencyKey: string; bankCode: string; phoneOrAccount: string; nationalId: string; amountMinor: bigint }): Promise<{ providerRef: string }>;
}

export interface CardIssuer {
  /** Card data (PAN/CVV) stays with the issuer-processor; Puente only stores the token. */
  issueVirtualCard(userId: string): Promise<{ cardToken: string; last4: string }>;
}
