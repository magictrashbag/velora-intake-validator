import {
  evaluateTransfer, requiresOfacReport, addBusinessDays, customerFacingReasons, DEFAULT_POLICY,
  type Currency, type Party, type TransferContext, type KycTier,
} from '@puente/core';
import type { Tx } from './db.ts';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { audit, jsonBigint } from './audit.ts';
import { sha256 } from './auth.ts';
import { lockWallet, postLedgerTxn, systemAccount } from './ledger.ts';

/** Stable JSON (sorted keys) so a retry with re-ordered keys is the same request. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === 'bigint') return x.toString();
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      return Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return x;
  });
}

/** Denials for these reasons, repeated this many times in 24h, freeze the account. */
const SANCTIONS_STRIKES_TO_FREEZE = 3;

export interface MovementRequest {
  kind: Exclude<TransferContext['kind'], 'crypto_deposit'>;
  senderId: string;
  recipientId?: string;
  currency: Currency;
  amountMinor: bigint;
  amountUsdCents: bigint;
  idempotencyKey: string;
  /** The exact request body; same key + different body is rejected. */
  body: unknown;
  recipientBankCode?: string;
  counterpartyAddress?: TransferContext['counterpartyAddress'];
  /** Beneficiary side of the Travel Rule; originator is filled from the sender's KYC record. */
  travelRuleBeneficiary?: { beneficiaryName: string; beneficiaryWalletType: 'self_hosted' | 'vasp'; beneficiaryVaspName?: string };
  ip?: string;
  /** What leaves the sender's wallet. Checked BEFORE the gate, so an unfunded request learns
   *  nothing about screening, and reserved in compliance_hold if the gate says review. */
  debit: { currency: Currency; minor: bigint };
  /** Extra validation after the idempotency replay check and before the gate (e.g. quote expiry). */
  precheck?: (tx: Tx) => Promise<void>;
  /** Posts ledger legs; only called when the gate says allow. Returns ledger txn id. */
  post: (tx: Tx) => Promise<string>;
  /** Runs after the transfer row exists, in the same DB transaction (e.g. outbox rows). */
  afterRecord?: (tx: Tx, transferId: string, status: MovementResult['status']) => Promise<void>;
}

export interface MovementResult {
  transfer_id: string;
  status: 'posted' | 'held_for_review' | 'denied';
  reasons?: string[];
}

const PARTY_SQL = `SELECT id, status, kyc_tier, screening, country, legal_name,
                          floor(extract(epoch FROM now() - created_at) / 86400)::int AS age_days
                     FROM users WHERE id = $1`;

export function partyFromRow(row: any): Party {
  return {
    userId: row.id, status: row.status, kycTier: row.kyc_tier as KycTier, screening: row.screening,
    country: row.country, accountAgeDays: row.age_days,
  };
}

export async function executeGatedMovement(tx: Tx, cfg: Config, m: MovementRequest): Promise<MovementResult> {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(m.idempotencyKey)) throw new AppError(400, 'idempotency_key_invalid');
  const requestHash = sha256(canonicalJson(m.body));

  // Serialise all money movement for this sender: makes idempotency and rolling limits race-free.
  // NO KEY UPDATE (not FOR UPDATE) so other transfers can still FK-reference this user without deadlocking.
  const s = await tx.query(`${PARTY_SQL} FOR NO KEY UPDATE`, [m.senderId]);
  const sender = s.rows[0];
  if (!sender) throw new AppError(404, 'user_not_found');

  const prior = await tx.query(
    'SELECT id, status, request_hash FROM transfers WHERE sender_user_id = $1 AND idempotency_key = $2',
    [m.senderId, m.idempotencyKey]);
  if (prior.rows[0]) {
    if (!prior.rows[0].request_hash.equals(requestHash)) throw new AppError(422, 'idempotency_key_reused');
    return replay(tx, prior.rows[0].id, prior.rows[0].status);
  }

  if (m.precheck) await m.precheck(tx);

  // Funds first. The sender row lock above serialises every debit of this wallet, so this
  // unlocked read can only be stale in the customer's favour (incoming credits); post()
  // re-checks under the wallet lock and the DB CHECK is the final backstop.
  const bal = await tx.query<{ balance: bigint }>(
    'SELECT balance FROM accounts WHERE owner_user_id = $1 AND currency = $2', [m.senderId, m.debit.currency]);
  if (!bal.rows[0] || bal.rows[0].balance < m.debit.minor) throw new AppError(422, 'insufficient_funds');

  let recipient: Party | undefined;
  if (m.recipientId) {
    const r = await tx.query(PARTY_SQL, [m.recipientId]);
    if (!r.rows[0]) throw new AppError(404, 'recipient_not_found');
    recipient = partyFromRow(r.rows[0]);
  }

  const p = DEFAULT_POLICY;
  const vol = await tx.query<{ d: bigint; m: bigint; near: number }>(
    `SELECT coalesce(sum(amount_usd_cents) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::bigint AS d,
            coalesce(sum(amount_usd_cents), 0)::bigint AS m,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours' AND (
                (amount_usd_cents < $2 AND amount_usd_cents * 10 >= $2 * 9) OR
                (amount_usd_cents < $3 AND amount_usd_cents * 10 >= $3 * 9)))::int AS near
       FROM transfers
      WHERE sender_user_id = $1 AND status IN ('posted','held_for_review')
        AND created_at > now() - interval '30 days'`,
    [m.senderId, p.travelRuleThresholdUsdCents.toString(), p.reviewAboveUsdCents.toString()]);

  // Travel Rule: the ORIGINATOR name comes from the KYC record, never from the request body.
  // A missing legal name leaves originatorName empty, which the gate treats as incomplete.
  const travelRule = m.travelRuleBeneficiary
    ? { originatorName: sender.legal_name ?? '', ...m.travelRuleBeneficiary }
    : undefined;

  const ctx: TransferContext = {
    kind: m.kind,
    sender: partyFromRow(sender),
    ...(recipient ? { recipient } : {}),
    ...(m.recipientBankCode ? { recipientBankCode: m.recipientBankCode } : {}),
    ...(m.counterpartyAddress ? { counterpartyAddress: m.counterpartyAddress } : {}),
    ...(travelRule ? { travelRule } : {}),
    amountUsdCents: m.amountUsdCents,
    sentLast24hUsdCents: vol.rows[0]!.d,
    sentLast30dUsdCents: vol.rows[0]!.m,
    recentNearThresholdCount: vol.rows[0]!.near,
  };
  const decision = evaluateTransfer(ctx, p);

  const status = decision.outcome === 'allow' ? 'posted' : decision.outcome === 'review' ? 'held_for_review' : 'denied';
  const ledgerTxnId = status === 'posted' ? await m.post(tx) : null;
  // A held transfer RESERVES its funds, so an approval later can never find them gone.
  let holdTxnId: string | null = null;
  if (status === 'held_for_review') {
    const w = await lockWallet(tx, m.senderId, m.debit.currency);
    if (w.balance < m.debit.minor) throw new AppError(422, 'insufficient_funds');
    holdTxnId = await postLedgerTxn(tx, 'hold', 'Held for compliance review', [
      { accountId: w.id, currency: m.debit.currency, amount: -m.debit.minor },
      { accountId: await systemAccount(tx, 'compliance_hold', m.debit.currency), currency: m.debit.currency, amount: m.debit.minor },
    ]);
  }

  const t = await tx.query<{ id: string }>(
    `INSERT INTO transfers (sender_user_id, recipient_user_id, kind, currency, amount_minor, amount_usd_cents,
                            status, ledger_txn_id, hold_ledger_txn_id, idempotency_key, request_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [m.senderId, m.recipientId ?? null, m.kind, m.currency, m.amountMinor.toString(), m.amountUsdCents.toString(),
     status, ledgerTxnId, holdTxnId, m.idempotencyKey, requestHash]);
  const transferId = t.rows[0]!.id;

  await tx.query(
    `INSERT INTO compliance_decisions (user_id, transfer_id, outcome, reasons, context, policy_version)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [m.senderId, transferId, decision.outcome, decision.reasons, JSON.stringify(ctx, jsonBigint), cfg.policyVersion]);

  if (ctx.travelRule && status !== 'denied' && m.amountUsdCents >= p.travelRuleThresholdUsdCents) {
    await tx.query(
      `INSERT INTO travel_rule_records (transfer_id, originator, beneficiary) VALUES ($1,$2,$3)`,
      [transferId,
       JSON.stringify({ name: ctx.travelRule.originatorName, user_id: m.senderId }),
       JSON.stringify({ name: ctx.travelRule.beneficiaryName, wallet_type: ctx.travelRule.beneficiaryWalletType,
         vasp: ctx.travelRule.beneficiaryVaspName ?? null, address: m.counterpartyAddress?.address ?? null })]);
  }

  if (requiresOfacReport(decision.reasons)) {
    await tx.query(
      `INSERT INTO ofac_reports (report_type, user_id, transfer_id, reasons, currency, amount_minor, due_by)
       VALUES ('rejected_transaction',$1,$2,$3,$4,$5,$6)`,
      [m.senderId, transferId, decision.reasons, m.currency, m.amountMinor.toString(),
       addBusinessDays(new Date(), 10).toISOString().slice(0, 10)]);
    // Repeated attempts to reach sanctioned parties/addresses: freeze pending review. Also stops
    // anyone using the endpoint as a free screening oracle.
    const strikes = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM compliance_decisions
        WHERE user_id = $1 AND outcome = 'deny' AND created_at > now() - interval '24 hours'
          AND EXISTS (SELECT 1 FROM unnest(reasons) r
                       WHERE r = 'address_sanctioned' OR r LIKE '%\_sanctions\_match' OR r LIKE '%\_jurisdiction\_blocked')`,
      [m.senderId]);
    if (strikes.rows[0]!.n >= SANCTIONS_STRIKES_TO_FREEZE) {
      await tx.query(`UPDATE users SET status = 'frozen' WHERE id = $1 AND status = 'active'`, [m.senderId]);
      await audit(tx, { actor: null, action: 'user.auto_frozen', subject: m.senderId, details: { strikes: strikes.rows[0]!.n } });
    }
  }

  if (m.afterRecord) await m.afterRecord(tx, transferId, status);
  await audit(tx, { actor: m.senderId, action: `transfer.${status}`, subject: transferId, details: { kind: m.kind }, ...(m.ip ? { ip: m.ip } : {}) });

  return result(transferId, status, decision.reasons);
}

async function replay(tx: Tx, id: string, status: MovementResult['status']): Promise<MovementResult> {
  const d = await tx.query('SELECT reasons FROM compliance_decisions WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1', [id]);
  return result(id, status, d.rows[0]?.reasons ?? []);
}

/** Customers see only safe reason codes; screening/sanctions/monitoring reasons would be tipping off. */
function result(id: string, status: MovementResult['status'], reasons: string[]): MovementResult {
  if (status !== 'denied') return { transfer_id: id, status };
  return { transfer_id: id, status, reasons: customerFacingReasons(reasons) };
}
