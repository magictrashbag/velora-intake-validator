/**
 * Daily compliance & integrity job. Produces one report, stores it in job_runs (append-only),
 * and returns ok=false if ANY check fails so the scheduler pages someone.
 */
import { addBusinessDays, type CustodyProvider, type SanctionsScreener } from '@puente/core';
import type { Db } from '../db.ts';
import { withTx } from '../db.ts';
import { audit, jsonBigint } from '../audit.ts';
import { openReviewCase } from '../movement.ts';
import { lockWallet, postLedgerTxn, systemAccount } from '../ledger.ts';

/** Severity order. Automation may only move a customer UP this list; clearing a match is a human,
 *  four-eyes decision taken in a review case. */
const SEVERITY = { clear: 0, pending: 1, potential_match: 2, confirmed_match: 3 } as const;

export interface DailyOptions {
  custody: CustodyProvider;
  screener: SanctionsScreener;
  reviewSlaHours?: number;
  ofacWarnBusinessDays?: number;
  rescreenAfterDays?: number;
  rescreenBatch?: number;
  now?: Date;
}

export interface DailyReport {
  ok: boolean;
  generated_at: string;
  reconciliation: { issues: string[]; custody: { ledger_expects: string; custodian_reports: string } };
  ofac: { overdue: any[]; due_soon: any[] };
  reviews: { sla_breached: any[] };
  withdrawals: { needs_attention: any[]; unconfirmed_24h: any[]; stalled_1h: any[] };
  rescreen: { screened: number; flagged: { user_id: string; result: string }[] };
}

export async function runDailyJobs(db: Db, o: DailyOptions): Promise<DailyReport> {
  const now = o.now ?? new Date();
  const issues: string[] = [];
  // All reconciliation reads run in ONE read-only REPEATABLE READ snapshot, so live postings
  // between queries can't produce phantom mismatches.
  let ledgerExpects = 0n;
  let custodian = { amountMinor: 0n, asOf: now };
  const snap = await db.connect();
  await snap.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const q = async (sql: string, p: unknown[] = []) => (await snap.query(sql, p)).rows;
  try {

  // --- Reconciliation -------------------------------------------------------------
  for (const r of await q(`SELECT a.id, a.kind, a.currency, a.balance, coalesce(sum(e.amount), 0)::bigint AS derived
                             FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
                            GROUP BY a.id HAVING a.balance <> coalesce(sum(e.amount), 0)`)) {
    issues.push(`balance_drift:${r.kind}/${r.currency}:${r.id}: cached ${r.balance} vs entries ${r.derived}`);
  }
  for (const r of await q(`SELECT currency, sum(balance)::bigint AS s FROM accounts GROUP BY currency HAVING sum(balance) <> 0`)) {
    issues.push(`currency_not_net_zero:${r.currency}:${r.s}`);
  }
  for (const r of await q(`SELECT txn_id, currency, sum(amount)::bigint AS s FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0`)) {
    issues.push(`unbalanced_txn:${r.txn_id}:${r.currency}`);
  }
  for (const r of await q(`SELECT e.txn_id FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.txn_id
                            GROUP BY e.txn_id, t.kind
                           HAVING (t.kind = 'fx' AND (count(DISTINCT e.currency) <> 2 OR NOT bool_or(e.currency = 'USDC')))
                               OR (t.kind <> 'fx' AND count(DISTINCT e.currency) > 1)`)) {
    issues.push(`unrouted_conversion:${r.txn_id}`);
  }
  const sysBal = async (kind: string, cur: string) =>
    ((await q(`SELECT balance FROM accounts WHERE owner_user_id IS NULL AND kind = $1 AND currency = $2`, [kind, cur]))[0]?.balance ?? 0n) as bigint;
  for (const cur of ['USDC', 'VES']) {
    const held = (await q(
      `SELECT coalesce(sum(amount_minor), 0)::bigint AS s FROM (
         SELECT amount_minor FROM transfers WHERE status = 'held_for_review' AND currency = $1
         UNION ALL SELECT amount_minor FROM crypto_deposits WHERE disposition = 'held' AND resolved_at IS NULL AND $1 = 'USDC') x`, [cur]))[0].s;
    const hb = await sysBal('compliance_hold', cur);
    if (hb !== held) issues.push(`compliance_hold_mismatch:${cur}: account ${hb} vs open holds ${held}`);
    const reported = (await q(
      `SELECT coalesce(sum(amount_minor), 0)::bigint AS s FROM ofac_reports WHERE report_type = 'blocked_property' AND currency = $1`, [cur]))[0].s;
    const bb = await sysBal('blocked_funds', cur);
    if (bb !== reported) issues.push(`blocked_funds_unreported:${cur}: blocked ${bb} vs reported ${reported}`);
  }
  const inFlight = (await q(`SELECT coalesce(sum(amount_minor), 0)::bigint AS s FROM crypto_withdrawals WHERE status NOT IN ('confirmed','failed')`))[0].s as bigint;
  // Sent to the custodian but not yet confirmed: may or may not have left the omnibus wallet yet.
  const maybeGone = (await q(`SELECT coalesce(sum(amount_minor), 0)::bigint AS s FROM crypto_withdrawals WHERE status IN ('sending','broadcast')`))[0].s as bigint;
  const pc = await sysBal('payout_clearing', 'USDC');
  if (pc !== inFlight) issues.push(`payout_clearing_mismatch: account ${pc} vs in-flight withdrawals ${inFlight}`);

  // custody_float is the mirror of what the custodian holds for us (deposits make it negative).
  ledgerExpects = -(await sysBal('custody_float', 'USDC'));
  custodian = await o.custody.getOmnibusBalance();
  // Healthy range: between "nothing in flight has left yet" and "everything in flight has left".
  if (custodian.amountMinor > ledgerExpects || custodian.amountMinor < ledgerExpects - maybeGone) {
    issues.push(`custody_mismatch: ledger expects ${ledgerExpects - maybeGone}..${ledgerExpects}, custodian reports ${custodian.amountMinor}`);
  }
  } finally {
    await snap.query('COMMIT').catch(() => {});
    snap.release();
  }

  const q2 = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
  // --- OFAC deadlines ----------------------------------------------------------------
  const today = now.toISOString().slice(0, 10);
  const warnBy = addBusinessDays(now, o.ofacWarnBusinessDays ?? 3).toISOString().slice(0, 10);
  const overdue = await q2(`SELECT id, report_type, user_id, due_by::text FROM ofac_reports WHERE status = 'due' AND due_by < $1 ORDER BY due_by`, [today]);
  const dueSoon = await q2(`SELECT id, report_type, user_id, due_by::text FROM ofac_reports WHERE status = 'due' AND due_by >= $1 AND due_by <= $2 ORDER BY due_by`, [today, warnBy]);
  if (overdue.length) issues.push(`ofac_reports_overdue:${overdue.length}`);

  // --- Review SLA ------------------------------------------------------------------
  const sla = await q2(
    `SELECT id, subject_type, opened_at FROM review_cases
      WHERE status IN ('open','awaiting_second_approval') AND opened_at < $1::timestamptz - make_interval(hours => $2)
      ORDER BY opened_at`, [now.toISOString(), o.reviewSlaHours ?? 48]);
  if (sla.length) issues.push(`review_sla_breached:${sla.length}`);

  // --- Withdrawals ------------------------------------------------------------------
  const attention = await q2(`SELECT id, transfer_id, attempts, last_error FROM crypto_withdrawals WHERE needs_attention AND status NOT IN ('confirmed','failed')`);
  const unconfirmed = await q2(
    `SELECT id, transfer_id, updated_at FROM crypto_withdrawals WHERE status = 'broadcast' AND updated_at < $1::timestamptz - interval '24 hours'`,
    [now.toISOString()]);
  const stalled = await q2(
    `SELECT id, transfer_id, status, updated_at FROM crypto_withdrawals
      WHERE status IN ('queued','sending') AND NOT needs_attention AND updated_at < $1::timestamptz - interval '1 hour'`,
    [now.toISOString()]);
  if (attention.length) issues.push(`withdrawals_need_attention:${attention.length}`);
  if (stalled.length) issues.push(`withdrawals_stalled_1h:${stalled.length}`);
  if (unconfirmed.length) issues.push(`withdrawals_unconfirmed_24h:${unconfirmed.length}`);

  // --- Ongoing re-screening ------------------------------------------------------------
  const due = await q2(
    `SELECT id, legal_name, country FROM users
      WHERE legal_name IS NOT NULL AND status <> 'closed'
        AND (screened_at IS NULL OR screened_at < $1::timestamptz - make_interval(days => $2))
        AND (screening_attempted_at IS NULL OR screening_attempted_at < $1::timestamptz - interval '20 hours')
      ORDER BY coalesce(screening_attempted_at, screened_at) NULLS FIRST LIMIT $3`, [now.toISOString(), o.rescreenAfterDays ?? 30, o.rescreenBatch ?? 500]);
  const flagged: DailyReport['rescreen']['flagged'] = [];
  for (const u of due) {
    const r = await o.screener.screenPerson({ fullName: u.legal_name, country: u.country });
    await withTx(db, async (tx) => {
      const cur = (await tx.query('SELECT screening FROM users WHERE id = $1 FOR NO KEY UPDATE', [u.id])).rows[0];
      await tx.query('INSERT INTO person_screenings (user_id, result, provider_ref) VALUES ($1,$2,$3)', [u.id, r.result, r.providerRef]);
      await tx.query('UPDATE users SET screening_attempted_at = now() WHERE id = $1', [u.id]);
      if (r.result === 'pending') return; // provider not finished: keep the last known result
      if (SEVERITY[r.result] < SEVERITY[cur.screening as keyof typeof SEVERITY]) {
        // Never auto-downgrade (e.g. confirmed -> clear after a name change or vendor variance).
        await tx.query('UPDATE users SET screened_at = now() WHERE id = $1', [u.id]);
        await audit(tx, { action: 'screening.downgrade_ignored', subject: u.id, details: { have: cur.screening, got: r.result } });
        return;
      }
      await tx.query('UPDATE users SET screening = $2, screened_at = now() WHERE id = $1', [u.id, r.result]);
      if (r.result === 'confirmed_match' || r.result === 'potential_match') {
        if (cur.screening === r.result) return; // already known and handled
        flagged.push({ user_id: u.id, result: r.result });
        if (r.result === 'confirmed_match') {
          const fr = await tx.query(`UPDATE users SET status = 'frozen' WHERE id = $1 AND status = 'active'`, [u.id]);
          if (fr.rowCount) await audit(tx, { action: 'user.frozen_by_rescreen', subject: u.id });
          await blockWallets(tx, u.id);
          issues.push(`confirmed_sanctions_match:${u.id}`);
        }
        await openReviewCase(tx, 'user', u.id, u.id, [`rescreen_${r.result}`]);
      }
    });
  }

  const report: DailyReport = {
    ok: issues.length === 0,
    generated_at: now.toISOString(),
    reconciliation: { issues, custody: { ledger_expects: ledgerExpects.toString(), custodian_reports: custodian.amountMinor.toString() } },
    ofac: { overdue, due_soon: dueSoon },
    reviews: { sla_breached: sla },
    withdrawals: { needs_attention: attention, unconfirmed_24h: unconfirmed, stalled_1h: stalled },
    rescreen: { screened: due.length, flagged },
  };
  await db.query('INSERT INTO job_runs (job, ok, report) VALUES ($1,$2,$3)', ['daily', report.ok, JSON.stringify(report, jsonBigint)]);
  return report;
}

/** A confirmed sanctions match: every wallet balance becomes blocked property, with an OFAC report. */
async function blockWallets(tx: import('../db.ts').Tx, userId: string) {
  const wallets = await tx.query(`SELECT currency FROM accounts WHERE owner_user_id = $1 ORDER BY currency`, [userId]);
  for (const w0 of wallets.rows) {
    const w = await lockWallet(tx, userId, w0.currency);
    if (w.balance <= 0n) continue;
    await postLedgerTxn(tx, 'block', 'Wallet blocked: confirmed sanctions match', [
      { accountId: w.id, currency: w0.currency, amount: -w.balance },
      { accountId: await systemAccount(tx, 'blocked_funds', w0.currency), currency: w0.currency, amount: w.balance },
    ]);
    await tx.query(
      `INSERT INTO ofac_reports (report_type, user_id, account_id, reasons, currency, amount_minor, due_by)
       VALUES ('blocked_property',$1,$2,$3,$4,$5,$6)`,
      [userId, w.id, ['rescreen_confirmed_match'], w0.currency, w.balance.toString(), addBusinessDays(new Date(), 10).toISOString().slice(0, 10)]);
  }
}
