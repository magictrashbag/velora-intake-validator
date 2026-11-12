import type { Db } from './db.ts';
import { withTx } from './db.ts';
import { AppError } from './errors.ts';
import { audit } from './audit.ts';
import { lockWallet, postLedgerTxn, systemAccount } from './ledger.ts';

/**
 * Apply the custodian's final word on a withdrawal.
 *   confirmed: funds left the omnibus wallet -> payout_clearing settles against custody_float
 *   failed:    nothing left the chain -> payout_clearing refunds the customer's wallet
 * Idempotent for the same final status; a contradictory status is a 409 and an alert.
 */
export async function settleWithdrawal(db: Db, ev: {
  transfer_id: string; status: 'confirmed' | 'failed'; provider_ref: string; chain_tx_hash?: string; failure_reason?: string;
}) {
  return withTx(db, async (tx) => {
    const w = (await tx.query('SELECT * FROM crypto_withdrawals WHERE transfer_id = $1 FOR UPDATE', [ev.transfer_id])).rows[0];
    if (!w) throw new AppError(404, 'withdrawal_not_found');
    if (w.status === ev.status) return { transfer_id: ev.transfer_id, status: w.status, replayed: true };
    if (w.status === 'confirmed' || w.status === 'failed') {
      await audit(tx, { action: 'withdrawal.status_conflict', subject: w.id, details: { have: w.status, got: ev.status } });
      throw new AppError(409, 'withdrawal_status_conflict');
    }
    if (w.status === 'queued') {
      // The custodian reports on something we never sent: never act on it automatically.
      await audit(tx, { action: 'withdrawal.unexpected_status', subject: w.id, details: { got: ev.status } });
      throw new AppError(409, 'withdrawal_not_sent');
    }

    const amt: bigint = w.amount_minor;
    const clearing = await systemAccount(tx, 'payout_clearing', 'USDC');
    let txn: string;
    if (ev.status === 'confirmed') {
      txn = await postLedgerTxn(tx, 'payout', 'On-chain withdrawal confirmed', [
        { accountId: clearing, currency: 'USDC', amount: -amt },
        { accountId: await systemAccount(tx, 'custody_float', 'USDC'), currency: 'USDC', amount: amt },
      ]);
    } else {
      // Same lock order as customer movements: user row, then wallet.
      await tx.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [w.user_id]);
      const wallet = await lockWallet(tx, w.user_id, 'USDC');
      txn = await postLedgerTxn(tx, 'payout', 'Withdrawal failed — refunded', [
        { accountId: clearing, currency: 'USDC', amount: -amt },
        { accountId: wallet.id, currency: 'USDC', amount: amt },
      ]);
    }
    await tx.query(
      `UPDATE crypto_withdrawals SET status = $2, provider_ref = $3, chain_tx_hash = $4, last_error = $5,
              resolved_ledger_txn_id = $6, resolved_at = now(), updated_at = now() WHERE id = $1`,
      [w.id, ev.status, ev.provider_ref, ev.chain_tx_hash ?? null, ev.failure_reason ?? null, txn]);
    await audit(tx, { action: `withdrawal.${ev.status}`, subject: w.id, details: { transfer_id: ev.transfer_id } });
    return { transfer_id: ev.transfer_id, status: ev.status, replayed: false };
  });
}
