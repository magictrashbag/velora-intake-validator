/**
 * The compliance gate. EVERY money movement passes through `evaluateTransfer` before
 * anything is written to the ledger. It is a pure function so it can be unit-tested
 * exhaustively and its decisions replayed for auditors.
 *
 * All thresholds and lists here are PLACEHOLDERS to be set by the compliance officer
 * with counsel. They live in one place (`DEFAULT_POLICY`) so changes are reviewable.
 */

export type KycTier = 0 | 1 | 2;
export type UserStatus = 'active' | 'frozen' | 'closed';
export type ScreeningResult = 'clear' | 'pending' | 'potential_match' | 'confirmed_match';

export interface Party {
  userId: string;
  status: UserStatus;
  kycTier: KycTier;
  screening: ScreeningResult;
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
  govBankCodes: {
    '0102': 'Banco de Venezuela (state-owned)',
    '0163': 'Banco del Tesoro (state-owned)',
    '0166': 'Banco Agrícola de Venezuela (state-owned)',
    '0175': 'Banco Digital de los Trabajadores / ex-Bicentenario (state-owned)',
    '0177': 'BANFANB (state-owned)',
  },
  govBankOutcome: 'review',
};

export interface TransferContext {
  kind: 'p2p' | 'payout_bank' | 'fx' | 'card_spend' | 'remittance_in';
  sender: Party;
  /** Absent for payouts to external bank accounts. */
  recipient?: Party;
  /** Venezuelan 4-digit bank code for bank payouts (Pago Móvil / transfer). */
  recipientBankCode?: string;
  amountUsdCents: bigint;
  /** Sender's already-posted outgoing volume, from the ledger. */
  sentLast24hUsdCents: bigint;
  sentLast30dUsdCents: bigint;
}

export type Decision =
  | { outcome: 'allow'; reasons: string[] }
  | { outcome: 'review'; reasons: string[] }
  | { outcome: 'deny'; reasons: string[] };

export function evaluateTransfer(ctx: TransferContext, policy: Policy = DEFAULT_POLICY): Decision {
  const deny: string[] = [];
  const review: string[] = [];

  checkParty('sender', ctx.sender, deny, review);
  if (ctx.recipient) checkParty('recipient', ctx.recipient, deny, review);

  if (ctx.amountUsdCents <= 0n) deny.push('amount_not_positive');

  const lim = policy.limits[ctx.sender.kycTier];
  if (!lim) {
    deny.push('kyc_tier_insufficient');
  } else {
    if (ctx.amountUsdCents > lim.perTxnUsdCents) deny.push('limit_per_transaction');
    if (ctx.sentLast24hUsdCents + ctx.amountUsdCents > lim.dailyUsdCents) deny.push('limit_daily');
    if (ctx.sentLast30dUsdCents + ctx.amountUsdCents > lim.monthlyUsdCents) deny.push('limit_monthly');
  }

  if (ctx.kind === 'payout_bank') {
    const code = ctx.recipientBankCode;
    if (!code || !/^\d{4}$/.test(code)) {
      deny.push('bank_code_invalid');
    } else if (Object.hasOwn(policy.govBankCodes, code) && policy.govBankOutcome !== 'allow') {
      (policy.govBankOutcome === 'deny' ? deny : review).push(`gov_bank_counterparty:${code}`);
    }
  }

  if (ctx.amountUsdCents >= policy.reviewAboveUsdCents) review.push('amount_requires_review');

  if (deny.length) return { outcome: 'deny', reasons: deny };
  if (review.length) return { outcome: 'review', reasons: review };
  return { outcome: 'allow', reasons: [] };
}

function checkParty(role: string, p: Party, deny: string[], review: string[]) {
  if (p.status !== 'active') deny.push(`${role}_${p.status}`);
  if (p.screening === 'confirmed_match') deny.push(`${role}_sanctions_match`);
  else if (p.screening === 'potential_match') review.push(`${role}_screening_potential_match`);
  else if (p.screening === 'pending') review.push(`${role}_screening_pending`);
}
