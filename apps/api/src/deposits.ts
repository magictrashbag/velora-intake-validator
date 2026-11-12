import {
  evaluateTransfer, requiresOfacReport, addBusinessDays, normalizeAddress, parseAmount, usdCentsEquivalent,
  type Network, type SanctionsScreener,
} from '@puente/core';
import type { Db } from './db.ts';
import { withTx } from './db.ts';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { audit, jsonBigint } from './audit.ts';
import { lockWallet, postLedgerTxn, systemAccount } from './ledger.ts';
import { partyFromRow, openReviewCase } from './movement.ts';

export interface DepositEvent {
  userId: string;
  network: Network;
  txHash: string;
  /** Position of this transfer within the on-chain tx (log index / output index). */
  logIndex: number;
  fromAddress: string;
  amount: string; // USDC decimal string
}

export interface DepositResult { deposit_id: string; disposition: 'credited' | 'held' | 'blocked'; replayed: boolean }

/**
 * An on-chain USDC deposit has ARRIVED at the custodian; we cannot refuse it, only decide where
 * it sits in our ledger:
 *   clean                  -> credited to the user's wallet
 *   high-risk / any review -> compliance_hold (released only by a reviewer)
 *   sanctioned source      -> blocked_funds + OFAC blocked-property report due in 10 business days
 *   other deny             -> compliance_hold (e.g. frozen user, unsupported network)
 * Idempotent on (network, tx_hash, log_index): a replayed webhook returns the original outcome;
 * a "replay" whose user/amount/source differs is a conflict, never silently accepted.
 */
export async function processCryptoDeposit(
  db: Db, cfg: Config, screener: SanctionsScreener, ev: DepositEvent,
): Promise<DepositResult> {
  const amount = parseAmount(ev.amount, 'USDC');
  const from = normalizeAddress(ev.network, ev.fromAddress);
  const txHash = ev.network === 'solana' ? ev.txHash : ev.txHash.toLowerCase();
  const key = [ev.network, txHash, ev.logIndex] as const;

  const replayOf = async (q: Db | import('./db.ts').Tx) => {
    const r = await q.query(
      `SELECT id, disposition, user_id, amount_minor, from_address FROM crypto_deposits
        WHERE network = $1 AND tx_hash = $2 AND log_index = $3`, [...key]);
    const row = r.rows[0];
    if (!row) return null;
    if (row.user_id !== ev.userId || row.amount_minor !== amount.minor || row.from_address !== from) {
      await audit(db, { action: 'deposit.replay_conflict', subject: row.id, details: { event: { ...ev, txHash } } });
      throw new AppError(409, 'deposit_conflict');
    }
    return { deposit_id: row.id as string, disposition: row.disposition, replayed: true };
  };

  const existing = await replayOf(db);
  if (existing) return existing;

  // Screening is a network call: do it BEFORE opening the DB transaction.
  const scr = await screener.screenAddress(ev.network, from);

  return withTx(db, async (tx) => {
    const u = await tx.query(
      `SELECT id, status, kyc_tier, screening, country, floor(extract(epoch FROM now() - created_at) / 86400)::int AS age_days
         FROM users WHERE id = $1 FOR NO KEY UPDATE`, [ev.userId]);
    if (!u.rows[0]) throw new AppError(404, 'user_not_found');
    // Re-check under the lock in case of a concurrent duplicate webhook.
    const dup = await replayOf(tx);
    if (dup) return dup;

    await tx.query('INSERT INTO address_screenings (network, address, risk, provider_ref) VALUES ($1,$2,$3,$4)',
      [ev.network, from, scr.risk, scr.providerRef]);

    const ctx = {
      kind: 'crypto_deposit' as const,
      sender: partyFromRow(u.rows[0]),
      counterpartyAddress: { network: ev.network, address: from, risk: scr.risk },
      amountUsdCents: usdCentsEquivalent(amount)!,
      sentLast24hUsdCents: 0n,
      sentLast30dUsdCents: 0n,
      recentNearThresholdCount: 0,
    };
    const decision = evaluateTransfer(ctx);
    // Any sanctions nexus (source address, the customer, embargoed residence) => BLOCK, never
    // merely hold: held funds can be released by a reviewer, blocked property cannot.
    const disposition = decision.outcome === 'allow' ? 'credited'
      : requiresOfacReport(decision.reasons) ? 'blocked' : 'held';

    // Wallet before system accounts (global lock order; see postLedgerTxn).
    const target = disposition === 'credited'
      ? (await lockWallet(tx, ev.userId, 'USDC')).id
      : await systemAccount(tx, disposition === 'blocked' ? 'blocked_funds' : 'compliance_hold', 'USDC');

    const ledgerTxnId = await postLedgerTxn(tx, 'deposit', `USDC deposit (${ev.network}) ${disposition}`, [
      { accountId: await systemAccount(tx, 'custody_float', 'USDC'), currency: 'USDC', amount: -amount.minor },
      { accountId: target, currency: 'USDC', amount: amount.minor },
    ]);
    const dep = await tx.query<{ id: string }>(
      `INSERT INTO crypto_deposits (user_id, network, tx_hash, log_index, from_address, amount_minor, disposition, ledger_txn_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ev.userId, ev.network, txHash, ev.logIndex, from, amount.minor.toString(), disposition, ledgerTxnId]);
    const depositId = dep.rows[0]!.id;

    await tx.query(
      `INSERT INTO compliance_decisions (user_id, deposit_id, outcome, reasons, context, policy_version)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ev.userId, depositId, decision.outcome, decision.reasons, JSON.stringify(ctx, jsonBigint), cfg.policyVersion]);

    if (disposition === 'held') await openReviewCase(tx, 'deposit', depositId, ev.userId, decision.reasons);
    if (disposition === 'blocked') {
      await tx.query(
        `INSERT INTO ofac_reports (report_type, user_id, deposit_id, reasons, currency, amount_minor, due_by)
         VALUES ('blocked_property',$1,$2,$3,'USDC',$4,$5)`,
        [ev.userId, depositId, decision.reasons, amount.minor.toString(), addBusinessDays(new Date(), 10).toISOString().slice(0, 10)]);
    }
    await audit(tx, { actor: null, action: `deposit.${disposition}`, subject: depositId, details: { user: ev.userId, network: ev.network } });
    return { deposit_id: depositId, disposition, replayed: false };
  });
}
