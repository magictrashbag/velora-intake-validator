/**
 * The compliance gate. EVERY money movement passes through `evaluateTransfer` before
 * anything is written to the ledger. It is a pure function so it can be unit-tested
 * exhaustively and its decisions replayed for auditors.
 *
 * Design rules:
 *  - FAIL CLOSED: missing data (unscreened address, missing Travel Rule info, unknown network)
 *    is a deny, never an allow.
 *  - Every rule emits a stable reason code; the full list is stored with the decision.
 *  - All thresholds and lists are PLACEHOLDERS owned by the compliance officer, kept in one
 *    place (`DEFAULT_POLICY`) so changes are reviewable and versioned.
 */
import { BLOCKED_COUNTRIES } from './jurisdiction.ts';
import type { Network } from './crypto.ts';

export type KycTier = 0 | 1 | 2;
export type UserStatus = 'active' | 'frozen' | 'closed';
export type ScreeningResult = 'clear' | 'pending' | 'potential_match' | 'confirmed_match';
export type AddressRisk = 'clear' | 'high_risk' | 'sanctioned';

export interface Party {
  userId: string;
  status: UserStatus;
  kycTier: KycTier;
  screening: ScreeningResult;
  /** ISO-3166 alpha-2 residence country ('ZZ' = unknown until KYC). */
  country: string;
  accountAgeDays: number;
}

export interface LimitWindow {
  perTxnUsdCents: bigint;
  dailyUsdCents: bigint;
  monthlyUsdCents: bigint;
}

export interface Policy {
  /** Limits by KYC tier. Tier 0 (phone verified only) cannot move money. */
  limits: Record<KycTier, LimitWindow | null>;
  /** Transfers at/above this are allowed but queued for manual review. */
  reviewAboveUsdCents: bigint;
  /**
   * Travel Rule: originator/beneficiary information required at/above this amount for crypto
   * transfers leaving the platform. US BSA rule is US$3,000; FATF R.16 is USD/EUR 1,000.
   * We apply the STRICTER one so a single build works in every corridor.
   */
  travelRuleThresholdUsdCents: bigint;
  /** Networks we will send to / accept from. */
  allowedNetworks: readonly Network[];
  /** Residence countries we cannot serve (comprehensive embargoes). */
  blockedCountries: ReadonlySet<string>;
  /** New accounts moving large amounts quickly is a classic mule pattern. */
  newAccountDays: number;
  newAccountReviewAboveUsdCents: bigint;
  /** N or more recent transfers just under a reporting/review threshold => possible structuring. */
  structuringCount: number;
  /**
   * Venezuelan bank codes of Government-of-Venezuela–owned banks (blocked under EO 13884 by
   * default). As of 2026, OFAC General Licenses (GL 16C: personal remittances; GL 57, Apr 2026:
   * financial services with NAMED state banks) authorize much of this activity, so the default
   * outcome is manual 'review', not 'deny'. Counsel owns this list and outcome; licenses are
   * amended often. Seed list only.
   */
  govBankCodes: Record<string, string>;
  govBankOutcome: 'allow' | 'review' | 'deny';
}

export const DEFAULT_POLICY: Policy = {
  limits: {
    0: null,
    1: { perTxnUsdCents: 500_00n, dailyUsdCents: 500_00n, monthlyUsdCents: 2_000_00n },
    2: { perTxnUsdCents: 5_000_00n, dailyUsdCents: 5_000_00n, monthlyUsdCents: 20_000_00n },
  },
  reviewAboveUsdCents: 3_000_00n,
  travelRuleThresholdUsdCents: 1_000_00n,
  allowedNetworks: ['ethereum', 'polygon', 'base', 'solana'],
  blockedCountries: BLOCKED_COUNTRIES,
  newAccountDays: 7,
  newAccountReviewAboveUsdCents: 300_00n,
  structuringCount: 3,
  govBankCodes: {
    '0102': 'Banco de Venezuela (state-owned)',
    '0163': 'Banco del Tesoro (state-owned)',
    '0166': 'Banco Agrícola de Venezuela (state-owned)',
    '0175': 'Banco Digital de los Trabajadores / ex-Bicentenario (state-owned)',
    '0177': 'BANFANB (state-owned)',
  },
  govBankOutcome: 'review',
};

export interface TravelRuleInfo {
  originatorName: string;
  beneficiaryName: string;
  /** 'self_hosted' = unhosted wallet the customer controls; 'vasp' = another exchange/custodian. */
  beneficiaryWalletType: 'self_hosted' | 'vasp';
  beneficiaryVaspName?: string;
}

export interface TransferContext {
  kind: 'p2p' | 'payout_bank' | 'fx' | 'card_spend' | 'remittance_in' | 'crypto_withdrawal' | 'crypto_deposit';
  sender: Party;
  /** Absent for payouts to external bank accounts / wallets. */
  recipient?: Party;
  /** Venezuelan 4-digit bank code for bank payouts (Pago Móvil / transfer). */
  recipientBankCode?: string;
  /** External blockchain counterparty, already screened by the screening provider. */
  counterpartyAddress?: { network: string; address: string; risk: AddressRisk | 'unscreened' };
  travelRule?: TravelRuleInfo;
  amountUsdCents: bigint;
  /** Sender's already-posted outgoing volume, from the ledger. */
  sentLast24hUsdCents: bigint;
  sentLast30dUsdCents: bigint;
  /** Sender's transfers in the last 24h that landed within 10% below a threshold. */
  recentNearThresholdCount: number;
}

export type Decision =
  | { outcome: 'allow'; reasons: string[] }
  | { outcome: 'review'; reasons: string[] }
  | { outcome: 'deny'; reasons: string[] };

/** Reason codes that may be shown to the customer. Everything else (screening, sanctions,
 *  monitoring) is internal: disclosing it would be "tipping off". */
export const CUSTOMER_SAFE_REASONS: ReadonlySet<string> = new Set([
  'kyc_tier_insufficient', 'limit_per_transaction', 'limit_daily', 'limit_monthly',
  'bank_code_invalid', 'travel_rule_info_required', 'network_not_supported', 'jurisdiction_not_supported',
]);

const CRYPTO_KINDS = new Set<TransferContext['kind']>(['crypto_withdrawal', 'crypto_deposit']);

/** Is `amount` within 10% below `threshold`? */
export function isNearThreshold(amount: bigint, threshold: bigint): boolean {
  return amount < threshold && amount * 10n >= threshold * 9n;
}

export function evaluateTransfer(ctx: TransferContext, policy: Policy = DEFAULT_POLICY): Decision {
  const deny: string[] = [];
  const review: string[] = [];

  checkParty('sender', ctx.sender, policy, deny, review);
  if (ctx.recipient) checkParty('recipient', ctx.recipient, policy, deny, review);

  if (ctx.amountUsdCents <= 0n) deny.push('amount_not_positive');

  // Limits apply to outgoing value. Inbound crypto deposits are screened, not limited.
  if (ctx.kind !== 'crypto_deposit') {
    const lim = policy.limits[ctx.sender.kycTier];
    if (!lim) {
      deny.push('kyc_tier_insufficient');
    } else {
      if (ctx.amountUsdCents > lim.perTxnUsdCents) deny.push('limit_per_transaction');
      if (ctx.sentLast24hUsdCents + ctx.amountUsdCents > lim.dailyUsdCents) deny.push('limit_daily');
      if (ctx.sentLast30dUsdCents + ctx.amountUsdCents > lim.monthlyUsdCents) deny.push('limit_monthly');
    }
  }

  if (ctx.kind === 'payout_bank') {
    const code = ctx.recipientBankCode;
    if (!code || !/^\d{4}$/.test(code)) {
      deny.push('bank_code_invalid');
    } else if (Object.hasOwn(policy.govBankCodes, code) && policy.govBankOutcome !== 'allow') {
      (policy.govBankOutcome === 'deny' ? deny : review).push(`gov_bank_counterparty:${code}`);
    }
  }

  if (CRYPTO_KINDS.has(ctx.kind)) {
    const cp = ctx.counterpartyAddress;
    if (!cp) {
      deny.push('address_missing');
    } else {
      if (!(policy.allowedNetworks as readonly string[]).includes(cp.network)) deny.push('network_not_supported');
      if (cp.risk === 'unscreened') deny.push('address_unscreened');
      else if (cp.risk === 'sanctioned') deny.push('address_sanctioned');
      else if (cp.risk === 'high_risk') review.push('address_high_risk');
    }
    if (ctx.kind === 'crypto_withdrawal' && ctx.amountUsdCents >= policy.travelRuleThresholdUsdCents) {
      const tr = ctx.travelRule;
      const complete = tr && tr.originatorName.trim() && tr.beneficiaryName.trim() &&
        (tr.beneficiaryWalletType === 'self_hosted' || (tr.beneficiaryVaspName ?? '').trim());
      if (!complete) deny.push('travel_rule_info_required');
    }
  }

  if (ctx.amountUsdCents >= policy.reviewAboveUsdCents) review.push('amount_requires_review');

  if (ctx.sender.accountAgeDays < policy.newAccountDays && ctx.amountUsdCents >= policy.newAccountReviewAboveUsdCents &&
      ctx.kind !== 'crypto_deposit') {
    review.push('new_account_high_value');
  }

  const nearNow = isNearThreshold(ctx.amountUsdCents, policy.travelRuleThresholdUsdCents) ||
    isNearThreshold(ctx.amountUsdCents, policy.reviewAboveUsdCents);
  if (nearNow && ctx.recentNearThresholdCount + 1 >= policy.structuringCount) review.push('possible_structuring');

  if (deny.length) return { outcome: 'deny', reasons: deny };
  if (review.length) return { outcome: 'review', reasons: review };
  return { outcome: 'allow', reasons: [] };
}

function checkParty(role: string, p: Party, policy: Policy, deny: string[], review: string[]) {
  if (p.status !== 'active') deny.push(`${role}_${p.status}`);
  if (policy.blockedCountries.has(p.country)) deny.push(role === 'sender' ? 'jurisdiction_not_supported' : `${role}_jurisdiction_blocked`);
  if (p.screening === 'confirmed_match') deny.push(`${role}_sanctions_match`);
  else if (p.screening === 'potential_match') review.push(`${role}_screening_potential_match`);
  else if (p.screening === 'pending') review.push(`${role}_screening_pending`);
}

/** Reasons that oblige us to file with OFAC (blocked or rejected transaction report). */
export function requiresOfacReport(reasons: readonly string[]): boolean {
  return reasons.some((r) => r === 'address_sanctioned' || r.endsWith('_sanctions_match') || r.endsWith('_jurisdiction_blocked'));
}
