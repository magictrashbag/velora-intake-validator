import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db.ts';
import { runDailyJobs } from '../src/jobs/daily.ts';
import { mockCustody, mockScreener } from '../src/providers/mock.ts';
import { setup, login, verifiedUser, withdraw, haveDb, CLEAN, HIGH_RISK, SANCTIONED } from './helpers.ts';

let app: FastifyInstance;
let db: Db;
let teardown: () => Promise<void>;
before(async () => { if (haveDb) ({ app, db, teardown } = await setup()); });
after(async () => { if (haveDb) await teardown(); });
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !haveDb && 'DATABASE_URL not set' }, fn);

/** A custodian whose omnibus balance matches the ledger (what a healthy day looks like). */
async function honestCustody() {
  const c = mockCustody();
  const f = (await db.query(`SELECT balance FROM accounts WHERE owner_user_id IS NULL AND kind = 'custody_float' AND currency = 'USDC'`)).rows[0].balance;
  c.setOmnibus(-(f as bigint));
  return c.provider;
}
const run = async (extra: object = {}) => runDailyJobs(db, { custody: await honestCustody(), screener: mockScreener, ...extra });

t('a healthy book after real flows reconciles cleanly, and the run is recorded', async () => {
  const a = await verifiedUser(app);
  const b = await verifiedUser(app);
  await a.deposit('100');
  await a.send(b.phone, '10');
  await withdraw(app, a, { network: 'polygon', address: CLEAN, amount: '5' });
  await withdraw(app, a, { network: 'polygon', address: HIGH_RISK, amount: '5' }); // held
  await a.deposit('7', 'USDC', SANCTIONED);                                       // blocked + reported
  const r = await run();
  assert.deepEqual(r.reconciliation.issues, []);
  assert.equal(r.ok, true);
  const jr = await db.query(`SELECT ok FROM job_runs WHERE job = 'daily' ORDER BY id DESC LIMIT 1`);
  assert.equal(jr.rows[0].ok, true);
  await assert.rejects(db.query(`UPDATE job_runs SET ok = true`), /append-only/);
});

t('custodian balance that disagrees with the ledger fails the run', async () => {
  const c = mockCustody();
  c.setOmnibus(123n);
  const r = await runDailyJobs(db, { custody: c.provider, screener: mockScreener });
  assert.equal(r.ok, false);
  assert.ok(r.reconciliation.issues.some((i) => i.startsWith('custody_mismatch')));
});

t('defence in depth: a balance edited with triggers bypassed (e.g. by a superuser) is caught', async () => {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL session_replication_role = replica`); // disables triggers for this tx
    await c.query(`UPDATE accounts SET balance = balance + 1 WHERE kind = 'fee_revenue' AND currency = 'USDC'`);
    await c.query('COMMIT');
  } finally { c.release(); }
  const r = await run();
  assert.ok(r.reconciliation.issues.some((i) => i.startsWith('balance_drift:fee_revenue/USDC')), JSON.stringify(r.reconciliation.issues));
  assert.ok(r.reconciliation.issues.some((i) => i.startsWith('currency_not_net_zero:USDC')));
  // repair for the remaining tests
  const c2 = await db.connect();
  await c2.query('BEGIN'); await c2.query(`SET LOCAL session_replication_role = replica`);
  await c2.query(`UPDATE accounts SET balance = balance - 1 WHERE kind = 'fee_revenue' AND currency = 'USDC'`);
  await c2.query('COMMIT'); c2.release();
});

t('OFAC deadlines: overdue fails the run; due-soon is listed', async () => {
  const u = await login(app);
  const uid = (await db.query('SELECT id FROM users WHERE phone = $1', [u.phone])).rows[0].id;
  const dep = (await u.deposit('3', 'USDC', SANCTIONED)).json().deposit_id;
  const r1 = await run();
  assert.ok(!r1.ofac.overdue.length);
  await db.query(`UPDATE ofac_reports SET due_by = current_date - 1 WHERE deposit_id = $1`, [dep]);
  const r2 = await run();
  assert.equal(r2.ok, false);
  assert.ok(r2.ofac.overdue.some((x) => x.user_id === uid));
  await db.query(`UPDATE ofac_reports SET due_by = current_date + 1 WHERE deposit_id = $1`, [dep]);
  const r3 = await run();
  assert.ok(r3.ofac.due_soon.some((x) => x.user_id === uid));
  await db.query(`UPDATE ofac_reports SET status = 'filed', filed_at = now()`); // filed: no longer listed
  assert.equal((await run()).ofac.due_soon.length, 0);
});

t('review SLA breaches and stuck withdrawals are surfaced', async () => {
  const u = await verifiedUser(app);
  await u.deposit('20');
  const w = await withdraw(app, u, { network: 'polygon', address: HIGH_RISK, amount: '2' });
  await db.query(`UPDATE review_cases SET opened_at = now() - interval '3 days' WHERE subject_id = $1`, [w.json().transfer_id]);
  const w2 = await withdraw(app, u, { network: 'polygon', address: CLEAN, amount: '2' });
  await db.query(`UPDATE crypto_withdrawals SET status = 'sending', needs_attention = true, attempts = 5 WHERE transfer_id = $1`, [w2.json().transfer_id]);
  const r = await run();
  assert.ok(r.reviews.sla_breached.length >= 1);
  assert.ok(r.withdrawals.needs_attention.some((x) => x.transfer_id === w2.json().transfer_id));
  assert.equal(r.ok, false);
});

t('re-screening: confirmed match freezes + opens a case; potential match opens a case; clean stays clean', async () => {
  const bad = await verifiedUser(app);
  await bad.kyc({ legal_name: 'Persona SANCTIONED Ejemplo' });
  const maybe = await verifiedUser(app);
  await maybe.kyc({ legal_name: 'Persona MAYBE Ejemplo' });
  const good = await verifiedUser(app);
  const id = async (u: { phone: string }) => (await db.query('SELECT id, status, screening, screened_at FROM users WHERE phone = $1', [u.phone])).rows[0];

  const r = await run();
  const B = await id(bad), M = await id(maybe), G = await id(good);
  assert.deepEqual([B.status, B.screening], ['frozen', 'confirmed_match']);
  assert.deepEqual([M.status, M.screening], ['active', 'potential_match']);
  assert.deepEqual([G.status, G.screening], ['active', 'clear']);
  assert.ok(G.screened_at);
  assert.ok(r.rescreen.flagged.some((f) => f.user_id === B.id && f.result === 'confirmed_match'));
  const cases = await db.query(`SELECT reasons FROM review_cases WHERE subject_type = 'user' AND subject_id = ANY($1)`, [[B.id, M.id]]);
  assert.equal(cases.rowCount, 2);
  // New money arriving for the now-sanctioned customer is blocked property, not a balance.
  assert.equal((await bad.deposit('5', 'USDC', CLEAN)).json().disposition, 'blocked');
  // Recently screened users are not re-screened again today.
  const r2 = await run();
  assert.ok(!r2.rescreen.flagged.some((f) => f.user_id === B.id));
  const ev = await db.query('SELECT count(*)::int n FROM person_screenings WHERE user_id = $1', [G.id]);
  assert.equal(ev.rows[0].n, 1);
});

t('confirmed match by re-screening blocks the wallet, files an OFAC report and fails the run', async () => {
  const u = await verifiedUser(app);
  await u.deposit('40');
  await u.kyc({ legal_name: 'Otro SANCTIONED Cliente' });
  const uid = (await db.query('SELECT id FROM users WHERE phone = $1', [u.phone])).rows[0].id;
  const r = await run();
  assert.equal(r.ok, false);
  assert.ok(r.reconciliation.issues.includes(`confirmed_sanctions_match:${uid}`));
  assert.equal(await u.balance(), '0.000000');
  const rep = await db.query(`SELECT report_type, amount_minor FROM ofac_reports WHERE user_id = $1 AND account_id IS NOT NULL`, [uid]);
  assert.deepEqual(rep.rows[0], { report_type: 'blocked_property', amount_minor: 40_000_000n });
  // ...and the books still reconcile: blocked funds == reported.
  assert.ok(!r.reconciliation.issues.some((i) => i.startsWith('blocked_funds_unreported')));
});

t('re-screening never downgrades a confirmed match; officers cannot unfreeze it', async () => {
  const u = await verifiedUser(app);
  await u.kyc({ legal_name: 'Tercer SANCTIONED Cliente' });
  const uid = (await db.query('SELECT id FROM users WHERE phone = $1', [u.phone])).rows[0].id;
  await run();
  // Name changes / vendor variance: the next screening comes back clean.
  await u.kyc({ legal_name: 'Nombre Distinto' });
  await db.query(`UPDATE users SET screened_at = now() - interval '40 days', screening_attempted_at = NULL WHERE id = $1`, [uid]);
  await run();
  const st = await db.query('SELECT status, screening FROM users WHERE id = $1', [uid]);
  assert.deepEqual(st.rows[0], { status: 'frozen', screening: 'confirmed_match' });
  const { issueStaffToken } = await import('../src/staff.ts');
  const o1 = { authorization: `Bearer ${(await issueStaffToken(db, 'o1@kame.test', 'compliance_officer')).token}` };
  const o2 = { authorization: `Bearer ${(await issueStaffToken(db, 'o2@kame.test', 'compliance_officer')).token}` };
  const c = (await db.query(`SELECT id FROM review_cases WHERE subject_id = $1 AND status IN ('open','awaiting_second_approval')`, [uid])).rows[0];
  const act = (h: object) => app.inject({ method: 'POST', url: `/v1/staff/cases/${c.id}/approve`, headers: h as any, payload: { note: 'requesting unfreeze' } });
  await act(o1);
  const r = await act(o2);
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().refused_reasons, ['user_sanctions_match']);
});

t('stalled or abandoned withdrawals are surfaced', async () => {
  const u = await verifiedUser(app);
  await u.deposit('10');
  const w = await withdraw(app, u, { network: 'polygon', address: CLEAN, amount: '1' });
  await db.query(`UPDATE crypto_withdrawals SET updated_at = now() - interval '2 hours' WHERE transfer_id = $1`, [w.json().transfer_id]);
  const r = await run();
  assert.ok(r.withdrawals.stalled_1h.some((x) => x.transfer_id === w.json().transfer_id));
  // A claim lost at the attempt limit is flagged by the worker instead of disappearing.
  await db.query(`UPDATE crypto_withdrawals SET status = 'sending', attempts = 5, claimed_at = now() - interval '1 hour' WHERE transfer_id = $1`, [w.json().transfer_id]);
  const { runWithdrawalWorker } = await import('../src/workers/withdrawals.ts');
  const wr = await runWithdrawalWorker(db, mockCustody().provider, { maxAttempts: 5 });
  assert.ok(wr.flagged >= 1);
  const row = await db.query('SELECT needs_attention FROM crypto_withdrawals WHERE transfer_id = $1', [w.json().transfer_id]);
  assert.equal(row.rows[0].needs_attention, true);
});

t('custody reconciliation tolerates withdrawals that have left but are not yet confirmed', async () => {
  // Drain other in-flight rows so this test controls the window.
  await db.query(`UPDATE crypto_withdrawals SET needs_attention = true WHERE status IN ('queued','sending')`);
  const u = await verifiedUser(app);
  await u.deposit('50');
  const w = await withdraw(app, u, { network: 'polygon', address: CLEAN, amount: '20' });
  await db.query(`UPDATE crypto_withdrawals SET status = 'broadcast', needs_attention = false WHERE transfer_id = $1`, [w.json().transfer_id]);
  const f = (await db.query(`SELECT balance FROM accounts WHERE owner_user_id IS NULL AND kind = 'custody_float' AND currency = 'USDC'`)).rows[0].balance as bigint;
  const inflight = (await db.query(`SELECT coalesce(sum(amount_minor),0)::bigint s FROM crypto_withdrawals WHERE status IN ('sending','broadcast')`)).rows[0].s as bigint;
  for (const omnibus of [-f, -f - inflight]) {
    const c = mockCustody(); c.setOmnibus(omnibus);
    const r = await runDailyJobs(db, { custody: c.provider, screener: mockScreener });
    assert.ok(!r.reconciliation.issues.some((i) => i.startsWith('custody_mismatch')), `omnibus ${omnibus}: ${r.reconciliation.issues}`);
  }
  const c = mockCustody(); c.setOmnibus(-f - inflight - 1n);
  const bad = await runDailyJobs(db, { custody: c.provider, screener: mockScreener });
  assert.ok(bad.reconciliation.issues.some((i) => i.startsWith('custody_mismatch')));
});
