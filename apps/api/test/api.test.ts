import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db.ts';
import { setup, login, verifiedUser, haveDb } from './helpers.ts';

let app: FastifyInstance;
let db: Db;
let teardown: () => Promise<void>;

before(async () => {
  if (!haveDb) return;
  ({ app, db, teardown } = await setup());
});
after(async () => { if (haveDb) await teardown(); });

const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !haveDb && 'DATABASE_URL not set' }, fn);

t('OTP login: wrong code rejected, attempts capped, sessions required', async () => {
  const phone = '+584140000001';
  const s = await app.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { phone } });
  assert.equal(s.statusCode, 200);
  const code = s.json().dev_code as string;
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: wrong } });
    assert.equal(r.statusCode, 401);
  }
  // 6th attempt with the RIGHT code still fails: brute force window is closed.
  const r = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code } });
  assert.equal(r.statusCode, 401);

  assert.equal((await app.inject({ method: 'GET', url: '/v1/wallet' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/wallet', headers: { authorization: 'Bearer nope' } })).statusCode, 401);

  const u = await login(app);
  assert.equal(await u.balance(), '0.000000');
  const stored = await db.query('SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1', [Buffer.from(u.token)]);
  assert.equal(stored.rows[0].n, 0, 'raw token must never be stored');
  await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: u.h });
  assert.equal((await app.inject({ method: 'GET', url: '/v1/wallet', headers: u.h })).statusCode, 401);
});

t('unverified (tier 0) users cannot move money', async () => {
  const a = await login(app);
  const b = await login(app);
  await a.deposit('10');
  const r = await a.send(b.phone, '1');
  assert.equal(r.statusCode, 403);
  assert.deepEqual(r.json().reasons, ['kyc_tier_insufficient']);
  assert.equal(await a.balance(), '10.000000');
});

t('P2P transfer moves money exactly once, even when retried', async () => {
  const a = await verifiedUser(app);
  const b = await verifiedUser(app);
  await a.deposit('100');

  const r1 = await a.send(b.phone, '25.50', 'retry-key-0001');
  assert.equal(r1.statusCode, 201);
  assert.equal(r1.json().status, 'posted');
  const r2 = await a.send(b.phone, '25.50', 'retry-key-0001');
  assert.equal(r2.json().transfer_id, r1.json().transfer_id);
  assert.equal(await a.balance(), '74.500000');
  assert.equal(await b.balance(), '25.500000');

  const r3 = await a.send(b.phone, '99', 'retry-key-0001');
  assert.equal(r3.statusCode, 422);
  assert.equal(r3.json().error, 'idempotency_key_reused');
});

t('insufficient funds is rejected cleanly and nothing is recorded', async () => {
  const a = await verifiedUser(app);
  const b = await verifiedUser(app);
  await a.deposit('5');
  const r = await a.send(b.phone, '5.000001');
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().error, 'insufficient_funds');
  assert.equal(await a.balance(), '5.000000');
});

t('sanctions hits are blocked without tipping off the customer', async () => {
  const a = await verifiedUser(app);
  const b = await verifiedUser(app);
  await b.kyc({ screening: 'confirmed_match' });
  await a.deposit('50');
  const r = await a.send(b.phone, '10');
  assert.equal(r.statusCode, 403);
  assert.deepEqual(r.json().reasons, ['not_permitted']);
  assert.ok(!JSON.stringify(r.json()).includes('sanction'));
  const d = await db.query(`SELECT reasons FROM compliance_decisions ORDER BY id DESC LIMIT 1`);
  assert.deepEqual(d.rows[0].reasons, ['recipient_sanctions_match'], 'full reason kept internally for audit');
});

t('potential screening match holds the transfer for review; no money moves', async () => {
  const a = await verifiedUser(app);
  const b = await verifiedUser(app);
  await b.kyc({ screening: 'potential_match' });
  await a.deposit('50');
  const r = await a.send(b.phone, '10');
  assert.equal(r.statusCode, 202);
  assert.equal(r.json().status, 'held_for_review');
  assert.equal(await a.balance(), '50.000000');
  assert.equal(await b.balance(), '0.000000');
});

t('daily limit counts prior volume', async () => {
  const a = await verifiedUser(app, 1); // tier 1: $500/day
  const b = await verifiedUser(app);
  await a.deposit('1000');
  assert.equal((await a.send(b.phone, '300')).statusCode, 201);
  const r = await a.send(b.phone, '200.01');
  assert.equal(r.statusCode, 403);
  assert.deepEqual(r.json().reasons, ['limit_daily']);
  assert.equal((await a.send(b.phone, '200')).statusCode, 201);
});

t('concurrent spends can never overdraw a wallet', async () => {
  const a = await verifiedUser(app);
  const b = await verifiedUser(app);
  await a.deposit('100');
  const results = await Promise.all(Array.from({ length: 12 }, () => a.send(b.phone, '20')));
  const posted = results.filter((r) => r.statusCode === 201).length;
  assert.equal(posted, 5);
  assert.ok(results.every((r) => r.statusCode === 201 || r.json().error === 'insufficient_funds'));
  assert.equal(await a.balance(), '0.000000');
  assert.equal(await b.balance(), '100.000000');
});

t('opposite-direction concurrent transfers do not deadlock', async () => {
  const a = await verifiedUser(app);
  const b = await verifiedUser(app);
  await a.deposit('100');
  await b.deposit('100');
  const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a.send(b.phone, '1') : b.send(a.phone, '1'))));
  assert.ok(rs.every((r) => r.statusCode === 201), JSON.stringify(rs.map((r) => r.json())));
  assert.equal(await a.balance(), '100.000000');
});

t('Bs <-> USD exchange: firm quote, executes once, ledger balances', async () => {
  const a = await verifiedUser(app);
  await a.deposit('100');
  const q = await app.inject({ method: 'POST', url: '/v1/fx/quotes', headers: a.h, payload: { sell: 'USDC', buy: 'VES', amount: '10' } });
  assert.equal(q.statusCode, 201);
  // mid 40.00, 150bps spread against the customer: 10 * 40 * 0.985 = 394.00
  assert.equal(q.json().buy.amount, '394.00');
  const id = q.json().quote_id;
  const e1 = await app.inject({ method: 'POST', url: `/v1/fx/quotes/${id}/execute`, headers: a.h });
  const e2 = await app.inject({ method: 'POST', url: `/v1/fx/quotes/${id}/execute`, headers: a.h });
  assert.equal(e1.statusCode, 201);
  assert.equal(e2.json().transfer_id, e1.json().transfer_id);
  assert.equal(await a.balance('USDC'), '90.000000');
  assert.equal(await a.balance('VES'), '394.00');

  // Someone else's quote is invisible.
  const other = await verifiedUser(app);
  const x = await app.inject({ method: 'POST', url: `/v1/fx/quotes/${id}/execute`, headers: other.h });
  assert.equal(x.statusCode, 404);

  // Expired quote cannot be executed.
  const q2 = await app.inject({ method: 'POST', url: '/v1/fx/quotes', headers: a.h, payload: { sell: 'VES', buy: 'USDC', amount: '100' } });
  await db.query(`UPDATE fx_quotes SET expires_at = now() - interval '1 second' WHERE id = $1`, [q2.json().quote_id]);
  const e3 = await app.inject({ method: 'POST', url: `/v1/fx/quotes/${q2.json().quote_id}/execute`, headers: a.h });
  assert.equal(e3.statusCode, 409);
});

t('database enforces double-entry, append-only and no-overdraft on its own', async () => {
  const c = await db.connect();
  try {
    const acct = (await c.query(`SELECT id FROM accounts WHERE kind='custody_float' AND currency='USDC'`)).rows[0].id;
    // Unbalanced transaction is rejected at COMMIT.
    await c.query('BEGIN');
    const tx = (await c.query(`INSERT INTO ledger_transactions (kind, description) VALUES ('adjustment','x') RETURNING id`)).rows[0].id;
    await c.query(`INSERT INTO ledger_entries (txn_id, account_id, currency, amount) VALUES ($1,$2,'USDC',1)`, [tx, acct]);
    await assert.rejects(c.query('COMMIT'), /unbalanced/);

    await assert.rejects(c.query(`UPDATE ledger_entries SET amount = amount * 2`), /append-only/);
    await assert.rejects(c.query(`DELETE FROM audit_log`), /append-only/);
    await assert.rejects(c.query(`TRUNCATE compliance_decisions CASCADE`), /append-only/);
    await assert.rejects(c.query(`UPDATE accounts SET balance = -1 WHERE kind = 'user_wallet'`), /check constraint/);
  } finally {
    c.release();
  }
});

t('global invariant: every currency nets to zero and cached balances match entries', async () => {
  const net = await db.query(`SELECT currency, sum(balance)::bigint AS s FROM accounts GROUP BY currency`);
  for (const r of net.rows) assert.equal(r.s, 0n, `${r.currency} does not net to zero`);
  const drift = await db.query(
    `SELECT a.id FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id, a.balance HAVING a.balance <> coalesce(sum(e.amount), 0)`);
  assert.equal(drift.rowCount, 0);
});

t('production mode: dev simulators are not registered and OTP codes are not echoed', async () => {
  const { buildApp } = await import('../src/app.ts');
  const { loadConfig } = await import('../src/config.ts');
  const prod = await buildApp({ db, config: loadConfig({ NODE_ENV: 'production', OTP_PEPPER: 'test-pepper' }) });
  try {
    for (const url of ['/v1/dev/deposit', '/v1/dev/kyc']) {
      assert.equal((await prod.inject({ method: 'POST', url, payload: {} })).statusCode, 404);
    }
    const s = await prod.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { phone: '+584149990000' } });
    assert.deepEqual(s.json(), { sent: true });
  } finally {
    await prod.close();
  }
});
