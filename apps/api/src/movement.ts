import { evaluateTransfer, type Currency, type Party, type TransferContext, type KycTier } from '@puente/core';
import type { Tx } from './db.ts';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { audit, jsonBigint } from './audit.ts';
import { sha256 } from './auth.ts';

/** Reasons we may show the customer. Anything else (esp. screening) is NEVER disclosed:
 *  telling a customer they hit a sanctions/AML check is "tipping off". */
const USER_SAFE = new Set(['kyc_tier_insufficient', 'limit_per_transaction', 'limit_daily', 'limit_monthly', 'bank_code_invalid']);

export interface MovementRequest {
  kind: TransferContext['kind'];
  senderId: string;
  recipientId?: string;
  currency: Currency;
  amountMinor: bigint;
  amountUsdCents: bigint;
  idempotencyKey: string;
  /** The exact request body; same key + different body is rejected. */
  body: unknown;
  recipientBankCode?: string;
  ip?: string;
  /** Posts ledger legs; only called when the gate says allow. Returns ledger txn id. */
  post: (tx: Tx) => Promise<string>;
}

export interface MovementResult {
  transfer_id: string;
  status: 'posted' | 'held_for_review' | 'denied';
  reasons?: string[];
}

export async function executeGatedMovement(tx: Tx, cfg: Config, m: MovementRequest): Promise<MovementResult> {
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(m.idempotencyKey)) throw new AppError(400, 'idempotency_key_invalid');
  const requestHash = sha256(JSON.stringify(m.body, jsonBigint));

  // Serialise all money movement for this sender: makes idempotency and rolling limits race-free.
  // NO KEY UPDATE (not FOR UPDATE) so other transfers can still FK-reference this user without deadlocking.
  const s = await tx.query('SELECT id, status, kyc_tier, screening FROM users WHERE id = $1 FOR NO KEY UPDATE', [m.senderId]);
  const sender = s.rows[0];
  if (!sender) throw new AppError(404, 'user_not_found');

  const prior = await tx.query(
    'SELECT id, status, request_hash FROM transfers WHERE sender_user_id = $1 AND idempotency_key = $2',
    [m.senderId, m.idempotencyKey]);
  if (prior.rows[0]) {
    if (!prior.rows[0].request_hash.equals(requestHash)) throw new AppError(422, 'idempotency_key_reused');
    return replay(tx, prior.rows[0].id, prior.rows[0].status);
  }

  let recipient: Party | undefined;
  if (m.recipientId) {
    const r = await tx.query('SELECT id, status, kyc_tier, screening FROM users WHERE id = $1', [m.recipientId]);
    if (!r.rows[0]) throw new AppError(404, 'recipient_not_found');
    recipient = party(r.rows[0]);
  }

  const vol = await tx.query<{ d: bigint; m: bigint }>(
    `SELECT coalesce(sum(amount_usd_cents) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::bigint AS d,
            coalesce(sum(amount_usd_cents), 0)::bigint AS m
       FROM transfers
      WHERE sender_user_id = $1 AND status IN ('posted','held_for_review')
        AND created_at > now() - interval '30 days'`,
    [m.senderId]);

  const ctx: TransferContext = {
    kind: m.kind,
    sender: party(sender),
    ...(recipient ? { recipient } : {}),
    ...(m.recipientBankCode ? { recipientBankCode: m.recipientBankCode } : {}),
    amountUsdCents: m.amountUsdCents,
    sentLast24hUsdCents: vol.rows[0]!.d,
    sentLast30dUsdCents: vol.rows[0]!.m,
  };
  const decision = evaluateTransfer(ctx);

  const status = decision.outcome === 'allow' ? 'posted' : decision.outcome === 'review' ? 'held_for_review' : 'denied';
  const ledgerTxnId = status === 'posted' ? await m.post(tx) : null;

  const t = await tx.query<{ id: string }>(
    `INSERT INTO transfers (sender_user_id, recipient_user_id, kind, currency, amount_minor, amount_usd_cents,
                            status, ledger_txn_id, idempotency_key, request_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [m.senderId, m.recipientId ?? null, m.kind, m.currency, m.amountMinor.toString(), m.amountUsdCents.toString(),
     status, ledgerTxnId, m.idempotencyKey, requestHash]);
  const transferId = t.rows[0]!.id;

  await tx.query(
    `INSERT INTO compliance_decisions (user_id, transfer_id, outcome, reasons, context, policy_version)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [m.senderId, transferId, decision.outcome, decision.reasons, JSON.stringify(ctx, jsonBigint), cfg.policyVersion]);
  await audit(tx, { actor: m.senderId, action: `transfer.${status}`, subject: transferId, details: { kind: m.kind }, ...(m.ip ? { ip: m.ip } : {}) });

  return result(transferId, status, decision.reasons);
}

function party(row: any): Party {
  return { userId: row.id, status: row.status, kycTier: row.kyc_tier as KycTier, screening: row.screening };
}

async function replay(tx: Tx, id: string, status: MovementResult['status']): Promise<MovementResult> {
  const d = await tx.query('SELECT reasons FROM compliance_decisions WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1', [id]);
  return result(id, status, d.rows[0]?.reasons ?? []);
}

function result(id: string, status: MovementResult['status'], reasons: string[]): MovementResult {
  if (status !== 'denied') return { transfer_id: id, status };
  const safe = reasons.filter((r) => USER_SAFE.has(r));
  return { transfer_id: id, status, reasons: safe.length ? safe : ['not_permitted'] };
}
