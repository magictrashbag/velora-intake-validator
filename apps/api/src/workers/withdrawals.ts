import type { CustodyProvider, Network } from '@kame/core';
import type { Db } from '../db.ts';
import { audit } from '../audit.ts';

export interface WorkerOptions {
  batch?: number;
  /** A 'sending' claim older than this is considered abandoned and re-sent (same idempotency key). */
  staleAfterSeconds?: number;
  /** After this many attempts, stop retrying automatically and flag for a human. Never auto-refund. */
  maxAttempts?: number;
}

export interface WorkerResult { claimed: number; broadcast: number; errored: number; flagged: number }

export async function runWithdrawalWorker(db: Db, custody: CustodyProvider, o: WorkerOptions = {}): Promise<WorkerResult> {
  const batch = o.batch ?? 20;
  const stale = o.staleAfterSeconds ?? 300;
  const maxAttempts = o.maxAttempts ?? 5;
  const res: WorkerResult = { claimed: 0, broadcast: 0, errored: 0, flagged: 0 };

  // A claim that went stale after the LAST allowed attempt (worker crashed) is flagged for a human.
  const abandoned = await db.query(
    `UPDATE crypto_withdrawals SET needs_attention = true, last_error = coalesce(last_error, 'worker lost claim at max attempts'), updated_at = now()
      WHERE status = 'sending' AND needs_attention = false AND attempts >= $1 AND claimed_at < now() - make_interval(secs => $2)
      RETURNING id`, [maxAttempts, stale]);
  for (const a of abandoned.rows) await audit(db, { action: 'withdrawal.needs_attention', subject: a.id, details: { reason: 'abandoned_claim' } });
  res.flagged += abandoned.rowCount ?? 0;

  // Claim atomically; SKIP LOCKED lets several workers run without sending anything twice.
  const claimed = await db.query(
    `UPDATE crypto_withdrawals w SET status = 'sending', claimed_at = now(), claim_token = gen_random_uuid(), attempts = attempts + 1
      WHERE w.id IN (
        SELECT id FROM crypto_withdrawals
         WHERE needs_attention = false AND attempts < $3
           AND (status = 'queued' OR (status = 'sending' AND claimed_at < now() - make_interval(secs => $2)))
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1)
      RETURNING w.id, w.transfer_id, w.network, w.address, w.amount_minor, w.attempts, w.claim_token`,
    [batch, stale, maxAttempts]);
  res.claimed = claimed.rowCount ?? 0;

  for (const w of claimed.rows) {
    try {
      const r = await custody.withdraw({
        idempotencyKey: w.transfer_id, network: w.network as Network, address: w.address, amountMinor: w.amount_minor,
      });
      // Only advance OUR claim: if another worker re-claimed it meanwhile, its update wins.
      await db.query(
        `UPDATE crypto_withdrawals SET status = 'broadcast', provider_ref = $2, last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'sending' AND claim_token = $3`, [w.id, r.providerRef, w.claim_token]);
      res.broadcast++;
    } catch (e: any) {
      res.errored++;
      const flag = w.attempts >= maxAttempts;
      await db.query(
        `UPDATE crypto_withdrawals SET last_error = $2, needs_attention = $3, updated_at = now()
          WHERE id = $1 AND claim_token = $4`,
        [w.id, String(e?.message ?? e).slice(0, 500), flag, w.claim_token]);
      if (flag) {
        res.flagged++;
        await audit(db, { action: 'withdrawal.needs_attention', subject: w.id, details: { attempts: w.attempts, error: String(e?.message ?? e) } });
      }
    }
  }
  return res;
}
