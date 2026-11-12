import {
  evaluateTransfer, addBusinessDays, normalizeAddress, parseAmount, usdCentsEquivalent,
  type Network, type SanctionsScreener,
} from '@puente/core';
import type { Db } from './db.ts';
import { withTx } from './db.ts';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { audit, jsonBigint } from './audit.ts';
import { postLedgerTxn, systemAccount } from './ledger.ts';
import { partyFromRow } from './movement.ts';

export interface DepositEvent {
  userId: string;
  network: Network;
  txHash: string;
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
 * Idempotent on (network, tx_hash): a replayed webhook returns the original outcome.
 */
export async function processCryptoDeposit(
  db: Db, cfg: Config, screener: SanctionsScreener, ev: DepositEvent,
): Promise<DepositResult> {
  const amount = parseAmount(ev.amount, 'USDC');
  const from = normalizeAddress(ev.network, ev.fromAddress);

  const existing = await db.query('SELECT id, disposition FROM crypto_deposits WHERE network = $1 AND tx_hash = $2',
    [ev.network, ev.txHash]);
  if (existing.rows[0]) return { deposit_id: existing.rows[0].id, disposition: existing.rows[0].disposition, replayed: true };

  // Screening is a network call: do it BEFORE opening the DB transaction.
  const scr = await screener.screenAddress(ev.network, from);

  return withTx(db, async (tx) => {
    const u = await tx.query(
      `SELECT id, status, kyc_tier, screening, country, floor(extract(epoch FROM now() - created_at) / 86400)::int AS age_days
         FROM users WHERE id = $1 FOR NO KEY UPDATE`, [ev.userId]);
    if (!u.rows[0]) throw new AppError(404, 'user_not_found');
    // Re-check under the lock in case of a concurrent duplicate webhook.
    const dup = await tx.query('SELECT id, disposition FROM crypto_deposits WHERE network = $1 AND tx_hash = $2', [ev.network, ev.txHash]);
    if (dup.rows[0]) return { deposit_id: dup.rows[0].id, disposition: dup.rows[0].disposition, replayed: true };

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
    const disposition = decision.outcome === 'allow' ? 'credited'
      : decision.reasons.includes('address_sanctioned') ? 'blocked' : 'held';

    const target = disposition === 'credited'
      ? (await tx.query(`SELECT id FROM accounts WHERE owner_user_id = $1 AND currency = 'USDC'`, [ev.userId])).rows[0].id
      : await systemAccount(tx, disposition === 'blocked' ? 'blocked_funds' : 'compliance_hold', 'USDC');

    const ledgerTxnId = await postLedgerTxn(tx, 'deposit', `USDC deposit (${ev.network}) ${disposition}`, [
      { accountId: await systemAccount(tx, 'custody_float', 'USDC'), currency: 'USDC', amount: -amount.minor },
      { accountId: target, currency: 'USDC', amount: amount.minor },
    ]);
    const dep = await tx.query<{ id: string }>(
      `INSERT INTO crypto_deposits (user_id, network, tx_hash, from_address, amount_minor, disposition, ledger_txn_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ev.userId, ev.network, ev.txHash, from, amount.minor.toString(), disposition, ledgerTxnId]);
    const depositId = dep.rows[0]!.id;

    await tx.query(
      `INSERT INTO compliance_decisions (user_id, deposit_id, outcome, reasons, context, policy_version)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ev.userId, depositId, decision.outcome, decision.reasons, JSON.stringify(ctx, jsonBigint), cfg.policyVersion]);

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
