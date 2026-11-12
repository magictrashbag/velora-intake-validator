import type { Currency } from '@puente/core';
import type { Tx } from './db.ts';
import { AppError } from './errors.ts';

export interface Leg { accountId: string; currency: Currency; amount: bigint }

/**
 * Post a balanced set of legs. The database independently re-checks balance at COMMIT and
 * blocks wallet overdrafts; this pre-check just gives a clean error instead of a 500.
 */
export async function postLedgerTxn(tx: Tx, kind: string, description: string, legs: Leg[]): Promise<string> {
  const sums = new Map<string, bigint>();
  for (const l of legs) {
    if (l.amount === 0n) throw new Error('zero-amount leg');
    sums.set(l.currency, (sums.get(l.currency) ?? 0n) + l.amount);
  }
  for (const [c, s] of sums) if (s !== 0n) throw new Error(`unbalanced ${c}: ${s}`);

  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO ledger_transactions (kind, description) VALUES ($1,$2) RETURNING id',
    [kind, description],
  );
  const txnId = rows[0]!.id;
  for (const l of legs) {
    try {
      await tx.query(
        'INSERT INTO ledger_entries (txn_id, account_id, currency, amount) VALUES ($1,$2,$3,$4)',
        [txnId, l.accountId, l.currency, l.amount.toString()],
      );
    } catch (e: any) {
      if (e?.code === '23514') throw new AppError(422, 'insufficient_funds');
      throw e;
    }
  }
  return txnId;
}

/** Lock and return a user's wallet for a currency. Locking serialises concurrent spends. */
export async function lockWallet(tx: Tx, userId: string, currency: Currency) {
  const { rows } = await tx.query<{ id: string; balance: bigint }>(
    `SELECT id, balance FROM accounts WHERE owner_user_id = $1 AND currency = $2 FOR NO KEY UPDATE`,
    [userId, currency],
  );
  if (!rows[0]) throw new AppError(422, 'wallet_not_found');
  return rows[0];
}

export async function systemAccount(tx: Tx, kind: string, currency: Currency): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM accounts WHERE owner_user_id IS NULL AND kind = $1 AND currency = $2',
    [kind, currency],
  );
  if (!rows[0]) throw new Error(`missing system account ${kind}/${currency}`);
  return rows[0].id;
}
