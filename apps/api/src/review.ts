/**
 * Review engine. Rules:
 *  - APPROVE needs two different staff (four-eyes). The second approval executes.
 *  - At execution the gate is re-run on TODAY's facts (fresh address screening, current
 *    screening/status/limits). If it would now deny, or raise review reasons the reviewers did not
 *    see, execution is refused and the refusal is recorded; the case stays open.
 *  - REJECT (refund) and BLOCK (blocked property + OFAC report) need one reviewer: both are the
 *    more restrictive outcome.
 *  - Unfreezing a user needs compliance_officer/admin approvals.
 *  - Every action, including refusals, lands in append-only review_actions.
 */
import {
  evaluateTransfer, addBusinessDays, type Currency, type Network, type SanctionsScreener, type AddressRisk,
} from '@puente/core';
import type { Db, Tx } from './db.ts';
import { withTx } from './db.ts';
import type { Config } from './config.ts';
import { AppError } from './errors.ts';
import { audit, jsonBigint } from './audit.ts';
import { lockWallet, postLedgerTxn, systemAccount } from './ledger.ts';
import { buildTransferContext, partyFromRow, PARTY_SQL } from './movement.ts';
import type { StaffUser } from './staff.ts';

export type ReviewAction = 'approve' | 'reject' | 'block' | 'comment';

export interface ReviewOutcome {
  case_id: string;
  status: 'open' | 'awaiting_second_approval' | 'approved' | 'rejected' | 'blocked';
  executed: boolean;
  refused_reasons?: string[];
}

interface Deps { db: Db; config: Config; screener: SanctionsScreener }

export async function actOnCase(d: Deps, staff: StaffUser, caseId: string, action: ReviewAction, note: string, ip?: string): Promise<ReviewOutcome> {
  if (note.trim().length < 5) throw new AppError(400, 'note_required', 'explain the decision (5+ characters)');
  const peek = await d.db.query('SELECT subject_type, subject_id, user_id FROM review_cases WHERE id = $1', [caseId]);
  const c0 = peek.rows[0];
  if (!c0) throw new AppError(404, 'case_not_found');

  // Fresh address screening for approvals that will send/credit crypto (network call: outside the tx).
  let freshRisk: AddressRisk | undefined;
  if (action === 'approve') {
    const addr = await addressFor(d.db, c0.subject_type, c0.subject_id);
    if (addr) {
      const scr = await d.screener.screenAddress(addr.network, addr.address);
      await d.db.query('INSERT INTO address_screenings (network, address, risk, provider_ref) VALUES ($1,$2,$3,$4)',
        [addr.network, addr.address, scr.risk, scr.providerRef]);
      freshRisk = scr.risk;
    }
  }

  return withTx(d.db, async (tx) => {
    // Same lock order as customer-initiated movement: user row first.
    await tx.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [c0.user_id]);
    const c = (await tx.query('SELECT * FROM review_cases WHERE id = $1 FOR UPDATE', [caseId])).rows[0];
    if (!['open', 'awaiting_second_approval'].includes(c.status)) throw new AppError(409, 'case_closed');
    if (c.subject_type === 'user' && action === 'approve' && staff.role === 'reviewer') {
      throw new AppError(403, 'forbidden', 'unfreezing requires a compliance officer');
    }

    const record = (a: string, n = note) =>
      tx.query('INSERT INTO review_actions (case_id, staff_id, action, note) VALUES ($1,$2,$3,$4)', [caseId, staff.id, a, n]);
    const close = async (status: string) => {
      await tx.query(`UPDATE review_cases SET status = $2, closed_at = now() WHERE id = $1`, [caseId, status]);
      await audit(tx, { actor: null, action: `review.${status}`, subject: caseId, details: { staff: staff.id }, ...(ip ? { ip } : {}) });
    };

    if (action === 'comment') {
      await record('comment');
      return { case_id: caseId, status: c.status, executed: false };
    }

    if (action === 'approve') {
      const prior = await tx.query<{ staff_id: string }>(
        `SELECT staff_id FROM review_actions WHERE case_id = $1 AND action = 'approve'`, [caseId]);
      if (prior.rows.some((r) => r.staff_id === staff.id)) throw new AppError(409, 'second_approver_must_differ');
      if (c.subject_type === 'user' && prior.rows.length) {
        const r = await tx.query(`SELECT role FROM staff WHERE id = $1`, [prior.rows[0]!.staff_id]);
        if (r.rows[0]?.role === 'reviewer') throw new AppError(409, 'first_approval_insufficient_role');
      }
      if (prior.rows.length === 0) {
        await record('approve');
        await tx.query(`UPDATE review_cases SET status = 'awaiting_second_approval' WHERE id = $1`, [caseId]);
        return { case_id: caseId, status: 'awaiting_second_approval', executed: false };
      }
      const refused = await executeApproval(tx, d, c, freshRisk);
      if (refused) {
        await record('execute_refused', `${note} | gate now: ${refused.join(', ')}`);
        return { case_id: caseId, status: c.status, executed: false, refused_reasons: refused };
      }
      await record('approve');
      await close('approved');
      return { case_id: caseId, status: 'approved', executed: true };
    }

    if (action === 'reject') {
      if (c.subject_type === 'deposit') throw new AppError(400, 'reject_not_supported', 'deposits are approved or blocked');
      if (c.subject_type === 'transfer') await releaseTransfer(tx, c.subject_id, 'refund');
      await record('reject');
      await close('rejected');
      return { case_id: caseId, status: 'rejected', executed: true };
    }

    // block
    if (c.subject_type === 'user') throw new AppError(400, 'block_not_supported', 'users stay frozen; reject the unfreeze');
    if (c.subject_type === 'transfer') await releaseTransfer(tx, c.subject_id, 'block');
    else await blockDeposit(tx, c.subject_id);
    await record('block');
    await close('blocked');
    return { case_id: caseId, status: 'blocked', executed: true };
  });
}

async function addressFor(db: Db, type: string, id: string): Promise<{ network: Network; address: string } | null> {
  if (type === 'deposit') {
    const r = await db.query('SELECT network, from_address FROM crypto_deposits WHERE id = $1', [id]);
    return r.rows[0] ? { network: r.rows[0].network, address: r.rows[0].from_address } : null;
  }
  if (type === 'transfer') {
    const r = await db.query(`SELECT details FROM transfers WHERE id = $1 AND kind = 'crypto_withdrawal'`, [id]);
    const det = r.rows[0]?.details;
    return det?.address ? { network: det.network, address: det.address } : null;
  }
  return null;
}

/** Returns refusal reasons, or null after executing. */
async function executeApproval(tx: Tx, d: Deps, c: any, freshRisk: AddressRisk | undefined): Promise<string[] | null> {
  if (c.subject_type === 'user') {
    const u = (await tx.query('SELECT screening, status FROM users WHERE id = $1', [c.subject_id])).rows[0];
    if (u.screening === 'confirmed_match') return ['user_sanctions_match'];
    await tx.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'frozen'`, [c.subject_id]);
    return null;
  }
  if (c.subject_type === 'deposit') return approveDeposit(tx, d, c, freshRisk);
  return approveTransfer(tx, d, c, freshRisk);
}

function judge(caseReasons: string[], outcome: string, reasons: string[]): string[] | null {
  if (outcome === 'deny') return reasons;
  if (outcome === 'review') {
    const fresh = reasons.filter((r) => !caseReasons.includes(r));
    if (fresh.length) return ['new_review_reasons', ...fresh];
  }
  return null;
}

async function approveTransfer(tx: Tx, d: Deps, c: any, freshRisk: AddressRisk | undefined): Promise<string[] | null> {
  const t = (await tx.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [c.subject_id])).rows[0];
  if (t.status !== 'held_for_review') throw new AppError(409, 'transfer_not_held');
  const det = t.details ?? {};
  const senderRow = (await tx.query(PARTY_SQL, [t.sender_user_id])).rows[0];
  const recipient = t.recipient_user_id ? partyFromRow((await tx.query(PARTY_SQL, [t.recipient_user_id])).rows[0]) : undefined;
  const ctx = await buildTransferContext(tx, {
    kind: t.kind,
    senderRow,
    ...(recipient ? { recipient } : {}),
    ...(det.recipient_bank_code ? { recipientBankCode: det.recipient_bank_code } : {}),
    ...(det.address ? { counterpartyAddress: { network: det.network, address: det.address, risk: freshRisk ?? 'unscreened' } } : {}),
    ...(det.travel_rule_beneficiary ? { travelRuleBeneficiary: det.travel_rule_beneficiary } : {}),
    amountUsdCents: t.amount_usd_cents,
    excludeTransferId: t.id,
  });
  const decision = evaluateTransfer(ctx);
  await tx.query(
    `INSERT INTO compliance_decisions (user_id, transfer_id, outcome, reasons, context, policy_version)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [t.sender_user_id, t.id, decision.outcome, decision.reasons, JSON.stringify({ reevaluation: true, ...ctx }, jsonBigint), d.config.policyVersion]);
  const refused = judge(c.reasons, decision.outcome, decision.reasons);
  if (refused) return refused;

  const cur = t.currency as Currency;
  const amt: bigint = t.amount_minor;
  const hold = await systemAccount(tx, 'compliance_hold', cur);
  let txn: string;
  if (t.kind === 'p2p') {
    const to = await lockWallet(tx, t.recipient_user_id, cur);
    txn = await postLedgerTxn(tx, 'p2p', 'P2P (released after review)', [
      { accountId: hold, currency: cur, amount: -amt },
      { accountId: to.id, currency: cur, amount: amt },
    ]);
  } else if (t.kind === 'crypto_withdrawal') {
    txn = await postLedgerTxn(tx, 'crypto_withdrawal', `Withdraw USDC (${det.network}) after review`, [
      { accountId: hold, currency: 'USDC', amount: -amt },
      { accountId: await systemAccount(tx, 'payout_clearing', 'USDC'), currency: 'USDC', amount: amt },
    ]);
    await tx.query(
      `INSERT INTO crypto_withdrawals (transfer_id, user_id, network, address, amount_minor) VALUES ($1,$2,$3,$4,$5)`,
      [t.id, t.sender_user_id, det.network, det.address, amt.toString()]);
  } else if (t.kind === 'fx') {
    const sell = det.sell as Currency;
    const buy = det.buy as Currency;
    const buyMinor = BigInt(det.buy_minor);
    const to = await lockWallet(tx, t.sender_user_id, buy);
    await tx.query(
      `SELECT id FROM accounts WHERE owner_user_id IS NULL AND kind = 'fx_inventory' AND currency = ANY($1)
        ORDER BY currency FOR NO KEY UPDATE`, [[sell, buy]]);
    txn = await postLedgerTxn(tx, 'fx', `Exchange ${sell}->${buy} (released after review, original quote)`, [
      { accountId: hold, currency: sell, amount: -amt },
      { accountId: await systemAccount(tx, 'fx_inventory', sell), currency: sell, amount: amt },
      { accountId: await systemAccount(tx, 'fx_inventory', buy), currency: buy, amount: -buyMinor },
      { accountId: to.id, currency: buy, amount: buyMinor },
    ]);
  } else {
    throw new AppError(400, 'kind_not_reviewable');
  }
  await tx.query(`UPDATE transfers SET status = 'posted', ledger_txn_id = $2, release_ledger_txn_id = $2 WHERE id = $1`, [t.id, txn]);
  return null;
}

/** Move a held transfer's reserve out of compliance_hold: back to the sender, or into blocked_funds. */
async function releaseTransfer(tx: Tx, transferId: string, mode: 'refund' | 'block') {
  const t = (await tx.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [transferId])).rows[0];
  if (t.status !== 'held_for_review') throw new AppError(409, 'transfer_not_held');
  const cur = t.currency as Currency;
  const amt: bigint = t.amount_minor;
  const target = mode === 'refund' ? (await lockWallet(tx, t.sender_user_id, cur)).id : await systemAccount(tx, 'blocked_funds', cur);
  const txn = await postLedgerTxn(tx, mode === 'refund' ? 'hold_release' : 'block',
    mode === 'refund' ? 'Returned after review' : 'Blocked after review', [
      { accountId: await systemAccount(tx, 'compliance_hold', cur), currency: cur, amount: -amt },
      { accountId: target, currency: cur, amount: amt },
    ]);
  await tx.query(`UPDATE transfers SET status = 'denied', release_ledger_txn_id = $2 WHERE id = $1`, [t.id, txn]);
  if (mode === 'block') {
    await tx.query(
      `INSERT INTO ofac_reports (report_type, user_id, transfer_id, reasons, currency, amount_minor, due_by)
       VALUES ('blocked_property',$1,$2,$3,$4,$5,$6)`,
      [t.sender_user_id, t.id, ['blocked_by_review'], cur, amt.toString(), addBusinessDays(new Date(), 10).toISOString().slice(0, 10)]);
  }
}

async function approveDeposit(tx: Tx, d: Deps, c: any, freshRisk: AddressRisk | undefined): Promise<string[] | null> {
  const dep = (await tx.query('SELECT * FROM crypto_deposits WHERE id = $1 FOR UPDATE', [c.subject_id])).rows[0];
  if (dep.disposition !== 'held' || dep.resolved_at) throw new AppError(409, 'deposit_not_held');
  const u = (await tx.query(PARTY_SQL, [dep.user_id])).rows[0];
  const ctx = {
    kind: 'crypto_deposit' as const,
    sender: partyFromRow(u),
    counterpartyAddress: { network: dep.network, address: dep.from_address, risk: freshRisk ?? 'unscreened' as const },
    amountUsdCents: (dep.amount_minor + 9_999n) / 10_000n,
    sentLast24hUsdCents: 0n, sentLast30dUsdCents: 0n, recentNearThresholdCount: 0,
  };
  const decision = evaluateTransfer(ctx);
  await tx.query(
    `INSERT INTO compliance_decisions (user_id, deposit_id, outcome, reasons, context, policy_version) VALUES ($1,$2,$3,$4,$5,$6)`,
    [dep.user_id, dep.id, decision.outcome, decision.reasons, JSON.stringify({ reevaluation: true, ...ctx }, jsonBigint), d.config.policyVersion]);
  const refused = judge(c.reasons, decision.outcome, decision.reasons);
  if (refused) return refused;
  const w = await lockWallet(tx, dep.user_id, 'USDC');
  const txn = await postLedgerTxn(tx, 'hold_release', 'Deposit credited after review', [
    { accountId: await systemAccount(tx, 'compliance_hold', 'USDC'), currency: 'USDC', amount: -dep.amount_minor },
    { accountId: w.id, currency: 'USDC', amount: dep.amount_minor },
  ]);
  await tx.query(`UPDATE crypto_deposits SET disposition = 'credited', resolved_ledger_txn_id = $2, resolved_at = now() WHERE id = $1`, [dep.id, txn]);
  return null;
}

async function blockDeposit(tx: Tx, depositId: string) {
  const dep = (await tx.query('SELECT * FROM crypto_deposits WHERE id = $1 FOR UPDATE', [depositId])).rows[0];
  if (dep.disposition !== 'held' || dep.resolved_at) throw new AppError(409, 'deposit_not_held');
  const txn = await postLedgerTxn(tx, 'block', 'Deposit blocked after review', [
    { accountId: await systemAccount(tx, 'compliance_hold', 'USDC'), currency: 'USDC', amount: -dep.amount_minor },
    { accountId: await systemAccount(tx, 'blocked_funds', 'USDC'), currency: 'USDC', amount: dep.amount_minor },
  ]);
  await tx.query(`UPDATE crypto_deposits SET disposition = 'blocked', resolved_ledger_txn_id = $2, resolved_at = now() WHERE id = $1`, [dep.id, txn]);
  await tx.query(
    `INSERT INTO ofac_reports (report_type, user_id, deposit_id, reasons, currency, amount_minor, due_by)
     VALUES ('blocked_property',$1,$2,$3,'USDC',$4,$5)`,
    [dep.user_id, dep.id, ['blocked_by_review'], dep.amount_minor.toString(), addBusinessDays(new Date(), 10).toISOString().slice(0, 10)]);
}
