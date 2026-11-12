import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db.ts';
import { issueStaffToken } from '../src/staff.ts';
import { runWithdrawalWorker } from '../src/workers/withdrawals.ts';
import { mockCustody } from '../src/providers/mock.ts';
import { setup, verifiedUser, withdraw, haveDb, CLEAN } from './helpers.ts';

let app: FastifyInstance;
let db: Db;
let teardown: () => Promise<void>;
let officer: Record<string, string>;
let reviewer: Record<string, string>;
before(async () => {
  if (!haveDb) return;
  ({ app, db, teardown } = await setup());
  officer = { authorization: `Bearer ${(await issueStaffToken(db, 'co@puente.test', 'compliance_officer')).token}` };
  reviewer = { authorization: `Bearer ${(await issueStaffToken(db, 'rv@puente.test', 'reviewer')).token}` };
});
after(async () => { if (haveDb) await teardown(); });
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !haveDb && 'DATABASE_URL not set' }, fn);

// Screens CLEAN with the vendor mock: only our local denylist can catch it.
const NEWLY_LISTED = '0x' + '4'.repeat(38) + 'Ab';
const list = (h: Record<string, string>, address = NEWLY_LISTED) => app.inject({
  method: 'POST', url: '/v1/staff/sanctions/addresses', headers: h,
  payload: { source: 'ofac_sdn', note: 'OFAC SDN update 2026-11-12', entries: [{ network: 'polygon', address, listed_on: '2026-11-12' }] },
});

t('only compliance officers can enter listings', async () => {
  assert.equal((await list(reviewer)).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/staff/sanctions/addresses', payload: {} })).statusCode, 401);
});

t('a new listing: halts unsent withdrawals, opens cases for exposed customers, blocks future use', async () => {
  // History before the listing: one customer received from the address, another has a withdrawal queued to it.
  const receiver = await verifiedUser(app);
  assert.equal((await receiver.deposit('20', 'USDC', NEWLY_LISTED)).json().disposition, 'credited');
  const sender = await verifiedUser(app);
  await sender.deposit('50');
  const w = await withdraw(app, sender, { network: 'polygon', address: NEWLY_LISTED, amount: '10' });
  assert.equal(w.statusCode, 201, 'vendor says clean before the listing');
  const bystander = await verifiedUser(app);
  await bystander.deposit('5', 'USDC', CLEAN);

  const r = await list(officer);
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.added, 1);
  assert.deepEqual(body.withdrawals_halted, [w.json().transfer_id]);
  assert.equal(body.deposits_found, 1);
  const ids = async (u: { phone: string }) => (await db.query('SELECT id FROM users WHERE phone = $1', [u.phone])).rows[0].id;
  assert.deepEqual(new Set(body.exposed_users), new Set([await ids(receiver), await ids(sender)]));
  const cases = await db.query(`SELECT reasons FROM review_cases WHERE subject_type = 'user' AND subject_id = ANY($1)`,
    [[await ids(receiver), await ids(sender)]]);
  assert.equal(cases.rowCount, 2);
  assert.ok(cases.rows.every((c) => c.reasons[0] === 'retro_sanctioned_address_exposure'));
  const by = await db.query(`SELECT 1 FROM review_cases WHERE subject_id = $1`, [await ids(bystander)]);
  assert.equal(by.rowCount, 0, 'no exposure, no case');

  // The worker will not send the halted withdrawal.
  const c = mockCustody();
  await runWithdrawalWorker(db, c.provider, { batch: 100 });
  assert.ok(!c.calls.some((x) => x.idempotencyKey === w.json().transfer_id));

  // From now on the address screens as sanctioned even though the vendor still says clean
  // (mixed-case input is normalised before the lookup).
  const again = await withdraw(app, sender, { network: 'polygon', address: NEWLY_LISTED.toUpperCase().replace('0X', '0x'), amount: '1' });
  assert.equal(again.statusCode, 403);
  const rep = await db.query('SELECT reasons FROM ofac_reports WHERE transfer_id = $1', [again.json().transfer_id]);
  assert.deepEqual(rep.rows[0].reasons, ['address_sanctioned']);
  assert.equal((await receiver.deposit('3', 'USDC', NEWLY_LISTED)).json().disposition, 'blocked');
});

t('re-submitting a listing is idempotent', async () => {
  const r = await list(officer);
  assert.equal(r.json().added, 0);
  assert.equal(r.json().already_listed, 1);
  await assert.rejects(db.query(`DELETE FROM sanctioned_addresses`), /append-only/);
});

t('malformed entries are rejected whole, nothing half-applied', async () => {
  const r = await app.inject({ method: 'POST', url: '/v1/staff/sanctions/addresses', headers: officer, payload: {
    source: 'ofac_sdn', note: 'batch with one bad row', entries: [{ network: 'base', address: '0x' + '5'.repeat(40) }, { network: 'base', address: 'nope' }] } });
  assert.equal(r.statusCode, 400);
  const n = await db.query(`SELECT count(*)::int n FROM sanctioned_addresses WHERE address = $1`, ['0x' + '5'.repeat(40)]);
  assert.equal(n.rows[0].n, 0);
});
