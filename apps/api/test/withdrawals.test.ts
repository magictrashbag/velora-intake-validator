import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db.ts';
import { runWithdrawalWorker } from '../src/workers/withdrawals.ts';
import { mockCustody } from '../src/providers/mock.ts';
import { signWebhook } from '../src/routes/crypto.ts';
import { setup, verifiedUser, withdraw, haveDb, CLEAN } from './helpers.ts';

let app: FastifyInstance;
let db: Db;
let teardown: () => Promise<void>;
before(async () => { if (haveDb) ({ app, db, teardown } = await setup()); });
after(async () => { if (haveDb) await teardown(); });
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !haveDb && 'DATABASE_URL not set' }, fn);

const SECRET = 'dev-only-webhook-secret';
const sys = async (kind: string) =>
  (await db.query(`SELECT balance FROM accounts WHERE owner_user_id IS NULL AND kind = $1 AND currency = 'USDC'`, [kind])).rows[0].balance as bigint;
const outbox = async (transferId: string) =>
  (await db.query('SELECT * FROM crypto_withdrawals WHERE transfer_id = $1', [transferId])).rows[0];
function settle(body: object) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return app.inject({ method: 'POST', url: '/v1/webhooks/custody/withdrawals', payload: raw,
    headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': signWebhook(SECRET, ts, raw) } });
}
async function queuedWithdrawal(amount = '30') {
  const u = await verifiedUser(app);
  await u.deposit('100');
  const r = await withdraw(app, u, { network: 'polygon', address: CLEAN, amount });
  assert.equal(r.statusCode, 201);
  return { u, transferId: r.json().transfer_id as string };
}
/** Drain anything left by other tests so each test sees only its own rows. */
const drain = async () => { await runWithdrawalWorker(db, mockCustody().provider, { batch: 1000 }); };

t('worker sends each queued withdrawal once, keyed by transfer id', async () => {
  await drain();
  const { transferId } = await queuedWithdrawal();
  const c = mockCustody();
  const r1 = await runWithdrawalWorker(db, c.provider);
  assert.deepEqual(r1, { claimed: 1, broadcast: 1, errored: 0, flagged: 0 });
  assert.equal(c.calls[0]!.idempotencyKey, transferId);
  assert.equal(c.calls[0]!.amountMinor, 30_000_000n);
  assert.equal((await outbox(transferId)).status, 'broadcast');
  assert.equal((await runWithdrawalWorker(db, c.provider)).claimed, 0);
});

t('parallel workers never double-send (SKIP LOCKED)', async () => {
  await drain();
  const ids = [];
  for (let i = 0; i < 8; i++) ids.push((await queuedWithdrawal('1')).transferId);
  const c = mockCustody();
  await Promise.all(Array.from({ length: 4 }, () => runWithdrawalWorker(db, c.provider, { batch: 3 })));
  await runWithdrawalWorker(db, c.provider, { batch: 100 });
  const keys = c.calls.map((x) => x.idempotencyKey).sort();
  assert.deepEqual(keys, [...ids].sort(), 'each exactly once');
});

t('custodian outage: retried with the SAME key after the claim goes stale; flagged, never auto-refunded', async () => {
  await drain();
  const { u, transferId } = await queuedWithdrawal();
  const c = mockCustody();
  c.failTimes(99);
  const r = await runWithdrawalWorker(db, c.provider, { maxAttempts: 2 });
  assert.equal(r.errored, 1);
  let w = await outbox(transferId);
  assert.equal(w.status, 'sending');
  assert.match(w.last_error, /timeout/);
  // Not stale yet: nothing re-sent.
  assert.equal((await runWithdrawalWorker(db, c.provider, { maxAttempts: 2 })).claimed, 0);
  await db.query(`UPDATE crypto_withdrawals SET claimed_at = now() - interval '1 hour' WHERE transfer_id = $1`, [transferId]);
  const r2 = await runWithdrawalWorker(db, c.provider, { maxAttempts: 2 });
  assert.deepEqual(r2, { claimed: 1, broadcast: 0, errored: 1, flagged: 1 });
  w = await outbox(transferId);
  assert.equal(w.needs_attention, true);
  assert.equal(await u.balance(), '70.000000', 'no automatic refund: the send may have happened');
  // Flagged rows are left for a human even when stale.
  await db.query(`UPDATE crypto_withdrawals SET claimed_at = now() - interval '1 hour' WHERE transfer_id = $1`, [transferId]);
  assert.equal((await runWithdrawalWorker(db, mockCustody().provider, { maxAttempts: 9 })).claimed, 0);
});

t('worker that crashed after claiming: the stale claim is re-sent with the same key', async () => {
  await drain();
  const { transferId } = await queuedWithdrawal();
  await db.query(`UPDATE crypto_withdrawals SET status = 'sending', claimed_at = now() - interval '1 hour', attempts = 1 WHERE transfer_id = $1`, [transferId]);
  const c = mockCustody();
  await runWithdrawalWorker(db, c.provider);
  assert.deepEqual(c.calls.map((x) => x.idempotencyKey), [transferId]);
  assert.equal((await outbox(transferId)).attempts, 2);
});

t('confirmation settles clearing against the custody float; replay is a no-op', async () => {
  await drain();
  const { transferId } = await queuedWithdrawal();
  await runWithdrawalWorker(db, mockCustody().provider);
  const clearing0 = await sys('payout_clearing');
  const float0 = await sys('custody_float');
  const r = await settle({ transfer_id: transferId, status: 'confirmed', provider_ref: 'p1', chain_tx_hash: '0xabc' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await sys('payout_clearing') - clearing0, -30_000_000n);
  assert.equal(await sys('custody_float') - float0, 30_000_000n);
  assert.equal((await settle({ transfer_id: transferId, status: 'confirmed', provider_ref: 'p1' })).json().replayed, true);
  assert.equal(await sys('payout_clearing') - clearing0, -30_000_000n, 'not applied twice');
  // A contradictory later report is refused and alerted, never applied.
  assert.equal((await settle({ transfer_id: transferId, status: 'failed', provider_ref: 'p1' })).statusCode, 409);
});

t('custodian-reported failure refunds the customer', async () => {
  await drain();
  const { u, transferId } = await queuedWithdrawal();
  await runWithdrawalWorker(db, mockCustody().provider);
  assert.equal(await u.balance(), '70.000000');
  const r = await settle({ transfer_id: transferId, status: 'failed', provider_ref: 'p2', failure_reason: 'address rejected' });
  assert.equal(r.statusCode, 200);
  assert.equal(await u.balance(), '100.000000');
});

t('status reports for never-sent withdrawals, or unsigned ones, are refused', async () => {
  await drain();
  const { transferId } = await queuedWithdrawal();
  // Still queued: the worker hasn't sent it, so a status report about it can't be genuine.
  assert.equal((await settle({ transfer_id: transferId, status: 'failed', provider_ref: 'x' })).json().error, 'withdrawal_not_sent');
  const raw = JSON.stringify({ transfer_id: transferId, status: 'failed', provider_ref: 'x' });
  const unsigned = await app.inject({ method: 'POST', url: '/v1/webhooks/custody/withdrawals', payload: raw, headers: { 'content-type': 'application/json' } });
  assert.equal(unsigned.statusCode, 401);
});

t('invariants hold after withdrawal flows', async () => {
  const net = await db.query(`SELECT currency, sum(balance)::bigint AS s FROM accounts GROUP BY currency`);
  for (const r of net.rows) assert.equal(r.s, 0n);
  // payout_clearing == sum of withdrawals not yet resolved
  const open = await db.query(`SELECT coalesce(sum(amount_minor),0)::bigint AS s FROM crypto_withdrawals WHERE status NOT IN ('confirmed','failed')`);
  assert.equal(await sys('payout_clearing'), open.rows[0].s);
});
