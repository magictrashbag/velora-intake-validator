import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db.ts';
import { issueStaffToken } from '../src/staff.ts';
import { setup, login, verifiedUser, withdraw, haveDb, CLEAN, HIGH_RISK } from './helpers.ts';

let app: FastifyInstance;
let db: Db;
let teardown: () => Promise<void>;
let alice: Record<string, string>; // reviewer
let bob: Record<string, string>;   // reviewer
let carol: Record<string, string>; // compliance officer
let dave: Record<string, string>;  // compliance officer

before(async () => {
  if (!haveDb) return;
  ({ app, db, teardown } = await setup());
  const tok = async (email: string, role: 'reviewer' | 'compliance_officer') =>
    ({ authorization: `Bearer ${(await issueStaffToken(db, email, role)).token}` });
  alice = await tok('alice@kame.test', 'reviewer');
  bob = await tok('bob@kame.test', 'reviewer');
  carol = await tok('carol@kame.test', 'compliance_officer');
  dave = await tok('dave@kame.test', 'compliance_officer');
});
after(async () => { if (haveDb) await teardown(); });
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !haveDb && 'DATABASE_URL not set' }, fn);

const act = (h: Record<string, string>, caseId: string, action: string, note = 'Reviewed evidence, documented in case file') =>
  app.inject({ method: 'POST', url: `/v1/staff/cases/${caseId}/${action}`, headers: h, payload: { note } });
const caseFor = async (subjectId: string) =>
  (await db.query('SELECT id, status, reasons FROM review_cases WHERE subject_id = $1 ORDER BY opened_at DESC LIMIT 1', [subjectId])).rows[0];
const sys = async (kind: string, cur = 'USDC') =>
  (await db.query(`SELECT balance FROM accounts WHERE owner_user_id IS NULL AND kind = $1 AND currency = $2`, [kind, cur])).rows[0].balance as bigint;

async function heldP2P() {
  const a = await verifiedUser(app);
  const b = await verifiedUser(app);
  await b.kyc({ screening: 'potential_match' });
  await a.deposit('50');
  const r = await a.send(b.phone, '10');
  assert.equal(r.statusCode, 202);
  return { a, b, transferId: r.json().transfer_id as string };
}

t('staff API is closed to customers and anonymous callers', async () => {
  const u = await verifiedUser(app);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/staff/cases' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/staff/cases', headers: u.h })).statusCode, 401);
  // ...and staff tokens are not customer tokens.
  assert.equal((await app.inject({ method: 'GET', url: '/v1/wallet', headers: alice })).statusCode, 401);
});

t('held transfer opens a case; staff see the internal reasons customers never see', async () => {
  const { transferId } = await heldP2P();
  const c = await caseFor(transferId);
  assert.deepEqual(c.reasons, ['recipient_screening_potential_match']);
  const list = await app.inject({ method: 'GET', url: '/v1/staff/cases', headers: alice });
  assert.ok(list.json().cases.some((x: any) => x.id === c.id));
  const detail = await app.inject({ method: 'GET', url: `/v1/staff/cases/${c.id}`, headers: alice });
  assert.equal(detail.json().subject.status, 'held_for_review');
  assert.equal(detail.json().decisions[0].outcome, 'review');
});

t('four-eyes: one approval waits, same person twice is refused, a second person executes', async () => {
  const { a, b, transferId } = await heldP2P();
  const c = await caseFor(transferId);
  const holdBefore = await sys('compliance_hold');

  const r1 = await act(alice, c.id, 'approve');
  assert.equal(r1.json().status, 'awaiting_second_approval');
  assert.equal(await b.balance(), '0.000000', 'nothing moves on one approval');
  assert.equal((await act(alice, c.id, 'approve')).json().error, 'second_approver_must_differ');

  const r2 = await act(bob, c.id, 'approve');
  assert.equal(r2.statusCode, 200, r2.body);
  assert.deepEqual(r2.json(), { case_id: c.id, status: 'approved', executed: true });
  assert.equal(await a.balance(), '40.000000');
  assert.equal(await b.balance(), '10.000000');
  assert.equal(await sys('compliance_hold') - holdBefore, -10_000_000n, 'reserve released');
  const tr = await db.query('SELECT status, ledger_txn_id, release_ledger_txn_id FROM transfers WHERE id = $1', [transferId]);
  assert.equal(tr.rows[0].status, 'posted');
  assert.equal(tr.rows[0].ledger_txn_id, tr.rows[0].release_ledger_txn_id);
  assert.equal((await act(carol, c.id, 'approve')).json().error, 'case_closed');
});

t('approval is judged on TODAY\'s facts: if the gate now denies, execution is refused and recorded', async () => {
  const { b, transferId } = await heldP2P();
  const c = await caseFor(transferId);
  await act(alice, c.id, 'approve');
  await b.kyc({ screening: 'confirmed_match' }); // recipient confirmed as sanctioned meanwhile
  const blockedBefore = await sys('blocked_funds');
  const r = await act(bob, c.id, 'approve');
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().refused_reasons, ['recipient_sanctions_match']);
  // A sanctions nexus is never left releasable: the reserve is blocked and reported automatically.
  assert.equal(r.json().auto_blocked, true);
  assert.equal(r.json().status, 'blocked');
  assert.equal(await b.balance(), '0.000000');
  assert.equal(await sys('blocked_funds') - blockedBefore, 10_000_000n);
  const acts = await db.query(`SELECT action FROM review_actions WHERE case_id = $1 ORDER BY id`, [c.id]);
  assert.deepEqual(acts.rows.map((x) => x.action), ['approve', 'execute_refused', 'block']);
  const rep = await db.query(`SELECT report_type FROM ofac_reports WHERE transfer_id = $1`, [transferId]);
  assert.equal(rep.rows[0].report_type, 'blocked_property');
});

t('new review reasons since the case opened also refuse execution', async () => {
  const { a, transferId } = await heldP2P();
  const c = await caseFor(transferId);
  await act(alice, c.id, 'approve');
  await a.kyc({ screening: 'potential_match' }); // sender newly flagged
  const r = await act(bob, c.id, 'approve');
  assert.deepEqual(r.json().refused_reasons, ['new_review_reasons', 'sender_screening_potential_match']);
});

t('reject returns the reserve to the sender (single reviewer)', async () => {
  const { a, b, transferId } = await heldP2P();
  const c = await caseFor(transferId);
  const r = await act(alice, c.id, 'reject');
  assert.equal(r.json().status, 'rejected');
  assert.equal(await a.balance(), '50.000000');
  assert.equal(await b.balance(), '0.000000');
  const tr = await db.query('SELECT status FROM transfers WHERE id = $1', [transferId]);
  assert.equal(tr.rows[0].status, 'denied');
});

t('a refund (reject) is refused when a sanctions nexus exists now', async () => {
  const { a, b, transferId } = await heldP2P();
  const c = await caseFor(transferId);
  await b.kyc({ screening: 'confirmed_match' });
  const r = await act(alice, c.id, 'reject');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'sanctions_nexus_must_block');
  assert.equal(await a.balance(), '40.000000', 'nothing returned');
});

t('a disabled staff member\'s earlier approval no longer counts', async () => {
  const { b, transferId } = await heldP2P();
  const c = await caseFor(transferId);
  const eve = { authorization: `Bearer ${(await issueStaffToken(db, 'eve@kame.test', 'reviewer')).token}` };
  await act(eve, c.id, 'approve');
  await db.query(`UPDATE staff SET status = 'disabled' WHERE email = 'eve@kame.test'`);
  const r = await act(bob, c.id, 'approve');
  assert.equal(r.json().status, 'awaiting_second_approval', 'bob becomes the FIRST valid approval');
  assert.equal(await b.balance(), '0.000000');
});

t('limits count released transfers on the day they execute (no bypass via old holds)', async () => {
  const a = await verifiedUser(app, 2); // $5,000/day
  const b = await verifiedUser(app);
  for (let i = 0; i < 3; i++) await a.deposit('2999');
  const h1 = await a.send(b.phone, '3000');
  await db.query(`UPDATE transfers SET created_at = now() - interval '2 days' WHERE id = $1`, [h1.json().transfer_id]);
  const h2 = await a.send(b.phone, '3000');
  await db.query(`UPDATE transfers SET created_at = now() - interval '2 days' WHERE id = $1`, [h2.json().transfer_id]);
  assert.equal(h1.statusCode, 202); assert.equal(h2.statusCode, 202);
  assert.equal((await a.send(b.phone, '1500')).statusCode, 201);
  const c1 = await caseFor(h1.json().transfer_id);
  await act(alice, c1.id, 'approve');
  assert.equal((await act(bob, c1.id, 'approve')).json().executed, true); // 1500 + 3000 today
  const c2 = await caseFor(h2.json().transfer_id);
  await act(alice, c2.id, 'approve');
  const r = await act(bob, c2.id, 'approve'); // would make 7500 today
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().refused_reasons, ['limit_daily']);
});

t('new reasons merged into a live case reset it: earlier approvals no longer count', async () => {
  const u = await verifiedUser(app);
  await u.deposit('10');
  for (let i = 0; i < 3; i++) await withdraw(app, u, { network: 'polygon', address: '0x' + '2'.repeat(36) + 'dead', amount: '1' });
  const uid = (await db.query('SELECT id FROM users WHERE phone = $1', [u.phone])).rows[0].id;
  const c = await caseFor(uid);
  await act(carol, c.id, 'approve');
  // A new alert on the same customer while the case awaits its second approval.
  const { openReviewCase } = await import('../src/movement.ts');
  const client = await db.connect();
  await openReviewCase(client as any, 'user', uid, uid, ['rescreen_potential_match']);
  client.release();
  await u.kyc({ screening: 'potential_match' });
  const merged = await caseFor(uid);
  assert.deepEqual(merged.reasons, ['auto_frozen_sanctions_strikes', 'rescreen_potential_match']);
  assert.equal(merged.status, 'open');
  const r = await act(dave, c.id, 'approve');
  assert.equal(r.json().status, 'awaiting_second_approval', "carol's earlier approval predates the new reason");
  const r2 = await act(carol, c.id, 'approve');
  assert.equal(r2.json().executed, true);
  const st = await db.query('SELECT status, screening FROM users WHERE id = $1', [uid]);
  assert.deepEqual(st.rows[0], { status: 'active', screening: 'clear' }, 'four-eyes approval dispositions the potential match');
});

t('decisions need a real note', async () => {
  const { transferId } = await heldP2P();
  const c = await caseFor(transferId);
  const r = await act(alice, c.id, 'reject', 'ok');
  assert.equal(r.json().error, 'note_required');
});

t('held withdrawal: approval re-screens the address and queues the on-chain send', async () => {
  const u = await verifiedUser(app);
  await u.deposit('100');
  const w = await withdraw(app, u, { network: 'polygon', address: HIGH_RISK, amount: '25' });
  assert.equal(w.statusCode, 202);
  const c = await caseFor(w.json().transfer_id);
  const screensBefore = (await db.query(`SELECT count(*)::int n FROM address_screenings WHERE address = $1`, [HIGH_RISK])).rows[0].n;
  await act(alice, c.id, 'approve');
  const r = await act(bob, c.id, 'approve');
  assert.equal(r.json().executed, true, r.body);
  const ob = await db.query('SELECT status, address FROM crypto_withdrawals WHERE transfer_id = $1', [w.json().transfer_id]);
  assert.deepEqual(ob.rows[0], { status: 'queued', address: HIGH_RISK });
  const screensAfter = (await db.query(`SELECT count(*)::int n FROM address_screenings WHERE address = $1`, [HIGH_RISK])).rows[0].n;
  assert.ok(screensAfter > screensBefore, 'fresh screening at approval');
  assert.equal(await u.balance(), '75.000000');
});

t('held FX executes at the original firm quote after approval', async () => {
  const u = await verifiedUser(app, 2);
  await u.deposit('2999');
  await u.deposit('1', 'USDC', CLEAN);
  const q = await app.inject({ method: 'POST', url: '/v1/fx/quotes', headers: u.h, payload: { sell: 'USDC', buy: 'VES', amount: '3000' } });
  const quoteId = q.json().quote_id;
  const e = await app.inject({ method: 'POST', url: `/v1/fx/quotes/${quoteId}/execute`, headers: u.h });
  assert.equal(e.statusCode, 202, e.body); // >= US$3,000 -> review
  assert.equal(await u.balance('USDC'), '0.000000', 'sell side reserved');
  const c = await caseFor(e.json().transfer_id);
  await act(alice, c.id, 'approve');
  assert.equal((await act(bob, c.id, 'approve')).json().executed, true);
  assert.equal(await u.balance('VES'), q.json().buy.amount);
});

t('held deposit: approved after the customer is screened clear; blocked deposits are reported', async () => {
  const u = await login(app); // screening pending -> deposit held
  const d = await u.deposit('40', 'USDC', CLEAN);
  assert.equal(d.json().disposition, 'held');
  const c = await caseFor(d.json().deposit_id);
  assert.equal((await act(alice, c.id, 'reject')).json().error, 'reject_not_supported');
  await act(alice, c.id, 'approve');
  await u.kyc({ screening: 'clear' }); // screening completes before the second approval
  const r = await act(bob, c.id, 'approve');
  assert.equal(r.json().executed, true, r.body);
  assert.equal(await u.balance(), '40.000000');

  const d2 = await u.deposit('15', 'USDC', HIGH_RISK);
  const c2 = await caseFor(d2.json().deposit_id);
  assert.equal((await act(bob, c2.id, 'block')).json().status, 'blocked');
  const rep = await db.query('SELECT report_type FROM ofac_reports WHERE deposit_id = $1', [d2.json().deposit_id]);
  assert.equal(rep.rows[0].report_type, 'blocked_property');
  assert.equal(await u.balance(), '40.000000');
});

t('auto-frozen user: unfreeze needs two compliance officers; reviewers cannot', async () => {
  const u = await verifiedUser(app);
  await u.deposit('10');
  for (let i = 0; i < 3; i++) await withdraw(app, u, { network: 'polygon', address: '0x' + '2'.repeat(36) + 'dead', amount: '1' });
  const userId = (await db.query('SELECT id FROM users WHERE phone = $1', [u.phone])).rows[0].id;
  const c = await caseFor(userId);
  assert.deepEqual(c.reasons, ['auto_frozen_sanctions_strikes']);
  assert.equal((await act(alice, c.id, 'approve')).statusCode, 403);
  await act(carol, c.id, 'approve');
  const r = await act(dave, c.id, 'approve');
  assert.equal(r.json().executed, true);
  assert.equal((await db.query('SELECT status FROM users WHERE id = $1', [userId])).rows[0].status, 'active');
});

t('review actions are append-only', async () => {
  await assert.rejects(db.query(`UPDATE review_actions SET note = 'rewritten history'`), /append-only/);
  await assert.rejects(db.query(`DELETE FROM review_actions`), /append-only/);
});

t('invariants hold after review flows', async () => {
  const net = await db.query(`SELECT currency, sum(balance)::bigint AS s FROM accounts GROUP BY currency`);
  for (const r of net.rows) assert.equal(r.s, 0n, `${r.currency} does not net to zero`);
  const drift = await db.query(
    `SELECT a.id FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id, a.balance HAVING a.balance <> coalesce(sum(e.amount), 0)`);
  assert.equal(drift.rowCount, 0);
  // compliance_hold equals the sum of everything still under review.
  const held = await db.query(
    `SELECT coalesce(sum(amount_minor) FILTER (WHERE currency = 'USDC'), 0)::bigint AS usdc FROM (
       SELECT currency, amount_minor FROM transfers WHERE status = 'held_for_review'
       UNION ALL SELECT 'USDC', amount_minor FROM crypto_deposits WHERE disposition = 'held' AND resolved_at IS NULL) x`);
  assert.equal(await sys('compliance_hold'), held.rows[0].usdc);
});
