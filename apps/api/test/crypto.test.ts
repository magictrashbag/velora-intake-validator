import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db.ts';
import { signWebhook } from '../src/routes/crypto.ts';
import { setup, login, verifiedUser, withdraw, haveDb, CLEAN, SANCTIONED, HIGH_RISK } from './helpers.ts';

let app: FastifyInstance;
let db: Db;
let teardown: () => Promise<void>;
before(async () => { if (haveDb) ({ app, db, teardown } = await setup()); });
after(async () => { if (haveDb) await teardown(); });
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !haveDb && 'DATABASE_URL not set' }, fn);

const sysBalance = async (kind: string, currency = 'USDC') =>
  (await db.query(`SELECT balance FROM accounts WHERE owner_user_id IS NULL AND kind = $1 AND currency = $2`, [kind, currency])).rows[0].balance as bigint;

t('sign-up from embargoed jurisdictions is refused', async () => {
  for (const phone of ['+5352345678', '+989121234567', '+79781234567']) {
    const r = await app.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { phone } });
    assert.equal(r.statusCode, 403, phone);
    assert.equal(r.json().error, 'jurisdiction_not_supported');
  }
  const u = await login(app, '+584125550000');
  const c = await db.query('SELECT country FROM users WHERE phone = $1', [u.phone]);
  assert.equal(c.rows[0].country, 'VE');
});

t('ROUTING: the database refuses any conversion that does not go through USDC', async () => {
  const c = await db.connect();
  const acct = async (kind: string, cur: string) =>
    (await c.query(`SELECT id FROM accounts WHERE owner_user_id IS NULL AND kind = $1 AND currency = $2`, [kind, cur])).rows[0].id;
  try {
    const legs = async (entries: [string, string, number][]) => {
      await c.query('BEGIN');
      const tx = (await c.query(`INSERT INTO ledger_transactions (kind, description) VALUES ('fx','t') RETURNING id`)).rows[0].id;
      for (const [id, cur, amt] of entries) {
        await c.query(`INSERT INTO ledger_entries (txn_id, account_id, currency, amount) VALUES ($1,$2,$3,$4)`, [tx, id, cur, amt]);
      }
      return c.query('COMMIT');
    };
    const usdFloat = await acct('custody_float', 'USD');
    const vesFloat = await acct('custody_float', 'VES');
    const vesFx = await acct('fx_inventory', 'VES');
    const usdcFx = await acct('fx_inventory', 'USDC');
    const usdcFloat = await acct('custody_float', 'USDC');
    // Direct fiat<->fiat: USD -> VES. Balanced, but not routed.
    await assert.rejects(legs([[usdFloat, 'USD', -100], [usdFloat, 'USD', 100], [vesFloat, 'VES', -4000], [vesFx, 'VES', 4000]]),
      /without routing through USDC/);
    // Three currencies netted in one transaction (USD->USDC->VES squashed): also refused.
    await assert.rejects(legs([[usdFloat, 'USD', -1], [usdFloat, 'USD', 1], [usdcFx, 'USDC', -1], [usdcFloat, 'USDC', 1],
      [vesFx, 'VES', -40], [vesFloat, 'VES', 40]]), /without routing through USDC/);
    // A proper leg (VES <-> USDC) commits.
    await legs([[vesFx, 'VES', -40], [vesFloat, 'VES', 40], [usdcFx, 'USDC', -1], [usdcFloat, 'USDC', 1]]);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const u = await verifiedUser(app);
  await assert.rejects(db.query(
    `INSERT INTO fx_quotes (user_id, sell_currency, buy_currency, sell_minor, buy_minor, mid_rate, spread_bps, rate_source, expires_at)
     VALUES ((SELECT id FROM users WHERE phone = $1), 'USD', 'VES', 1, 1, '1', 0, 'x', now())`, [u.phone]), /fx_quotes_routed/);
  const q = await app.inject({ method: 'POST', url: '/v1/fx/quotes', headers: u.h, payload: { sell: 'VES', buy: 'VES', amount: '1' } });
  assert.equal(q.statusCode, 400);
});

t('withdrawal to a clean address: debited, queued in the outbox, screening evidence kept', async () => {
  const u = await verifiedUser(app);
  await u.deposit('100');
  const before = await sysBalance('payout_clearing');
  const r = await withdraw(app, u, { network: 'polygon', address: CLEAN.toUpperCase().replace('0X', '0x'), amount: '40' });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(await u.balance(), '60.000000');
  assert.equal(await sysBalance('payout_clearing') - before, 40_000_000n);
  const ob = await db.query('SELECT status, address FROM crypto_withdrawals WHERE transfer_id = $1', [r.json().transfer_id]);
  assert.deepEqual(ob.rows[0], { status: 'queued', address: CLEAN }, 'address stored normalised');
  const ev = await db.query(`SELECT risk FROM address_screenings WHERE address = $1`, [CLEAN]);
  assert.ok(ev.rowCount! >= 1);
});

t('withdrawal to a sanctioned address: blocked, nothing moves, OFAC report due, customer not tipped off', async () => {
  const u = await verifiedUser(app);
  await u.deposit('100');
  const r = await withdraw(app, u, { network: 'ethereum', address: SANCTIONED, amount: '10' });
  assert.equal(r.statusCode, 403);
  assert.deepEqual(r.json().reasons, ['not_permitted']);
  assert.equal(await u.balance(), '100.000000');
  const rep = await db.query(`SELECT report_type, status, due_by, reasons FROM ofac_reports WHERE transfer_id = $1`, [r.json().transfer_id]);
  assert.equal(rep.rows[0].report_type, 'rejected_transaction');
  assert.equal(rep.rows[0].status, 'due');
  assert.deepEqual(rep.rows[0].reasons, ['address_sanctioned']);
  const days = (rep.rows[0].due_by.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 10 && days < 16, `due in ~14 calendar days, got ${days}`);
  const ob = await db.query('SELECT 1 FROM crypto_withdrawals WHERE transfer_id = $1', [r.json().transfer_id]);
  assert.equal(ob.rowCount, 0);
});

t('withdrawal to a high-risk address is held for review', async () => {
  const u = await verifiedUser(app);
  await u.deposit('100');
  const r = await withdraw(app, u, { network: 'base', address: HIGH_RISK, amount: '10' });
  assert.equal(r.statusCode, 202);
  assert.equal(await u.balance(), '100.000000');
});

t('withdrawal input validation: unsupported network, malformed address', async () => {
  const u = await verifiedUser(app);
  assert.equal((await withdraw(app, u, { network: 'tron', address: 'T' + 'a'.repeat(33), amount: '1' })).json().error, 'network_not_supported');
  assert.equal((await withdraw(app, u, { network: 'polygon', address: '0x123', amount: '1' })).json().error, 'address_invalid');
});

t('Travel Rule at US$1,000: required, recorded, originator taken from KYC only', async () => {
  const u = await verifiedUser(app, 2);
  await u.deposit('2999');
  const no = await withdraw(app, u, { network: 'polygon', address: CLEAN, amount: '1000' });
  assert.equal(no.statusCode, 403);
  assert.deepEqual(no.json().reasons, ['travel_rule_info_required']);

  const yes = await withdraw(app, u, {
    network: 'polygon', address: CLEAN, amount: '1000',
    travel_rule: { beneficiary_name: 'Ana María Pérez', wallet_type: 'self_hosted' },
  });
  assert.equal(yes.statusCode, 201, yes.body);
  const rec = await db.query('SELECT originator, beneficiary FROM travel_rule_records WHERE transfer_id = $1', [yes.json().transfer_id]);
  assert.equal(rec.rows[0].originator.name, 'Ana María Pérez');
  assert.equal(rec.rows[0].beneficiary.address, CLEAN);
  await assert.rejects(db.query('UPDATE travel_rule_records SET beneficiary = $1', ['{}']), /append-only/);

  // Same request from a user without a KYC legal name cannot satisfy the rule.
  const anon = await login(app);
  await anon.kyc({ kyc_tier: 2, screening: 'clear', age_days: 30 });
  await anon.deposit('2000');
  const r = await withdraw(app, anon, {
    network: 'polygon', address: CLEAN, amount: '1000',
    travel_rule: { beneficiary_name: 'Someone', wallet_type: 'self_hosted' },
  });
  assert.deepEqual(r.json().reasons, ['travel_rule_info_required']);
});

t('structuring: a third transfer just under the Travel Rule threshold is held', async () => {
  const u = await verifiedUser(app, 2);
  await u.deposit('2999');
  assert.equal((await withdraw(app, u, { network: 'polygon', address: CLEAN, amount: '950' })).statusCode, 201);
  assert.equal((await withdraw(app, u, { network: 'polygon', address: CLEAN, amount: '960' })).statusCode, 201);
  const third = await withdraw(app, u, { network: 'polygon', address: CLEAN, amount: '940' });
  assert.equal(third.statusCode, 202);
  const d = await db.query('SELECT reasons FROM compliance_decisions WHERE transfer_id = $1', [third.json().transfer_id]);
  assert.deepEqual(d.rows[0].reasons, ['possible_structuring']);
});

t('deposits for a not-yet-screened customer are held, never credited', async () => {
  const u = await login(app);
  assert.equal((await u.deposit('10', 'USDC', CLEAN)).json().disposition, 'held');
  assert.equal(await u.balance(), '0.000000');
});

t('large inbound deposits are held for review', async () => {
  const u = await verifiedUser(app, 2);
  assert.equal((await u.deposit('3000', 'USDC', CLEAN)).json().disposition, 'held');
});

t('deposits: clean credited, high-risk held, sanctioned blocked with OFAC blocked-property report', async () => {
  const u = await login(app);
  await u.kyc({ screening: 'clear' }); // tier 0 is fine for RECEIVING once screened
  const heldBefore = await sysBalance('compliance_hold');
  const blockedBefore = await sysBalance('blocked_funds');

  assert.equal((await u.deposit('10', 'USDC', CLEAN)).json().disposition, 'credited');
  assert.equal((await u.deposit('20', 'USDC', HIGH_RISK)).json().disposition, 'held');
  const b = await u.deposit('30', 'USDC', SANCTIONED);
  assert.equal(b.json().disposition, 'blocked');

  assert.equal(await u.balance(), '10.000000');
  assert.equal(await sysBalance('compliance_hold') - heldBefore, 20_000_000n);
  assert.equal(await sysBalance('blocked_funds') - blockedBefore, 30_000_000n);
  const rep = await db.query(`SELECT report_type, amount_minor FROM ofac_reports WHERE deposit_id = $1`, [b.json().deposit_id]);
  assert.deepEqual(rep.rows[0], { report_type: 'blocked_property', amount_minor: 30_000_000n });
});

t('custodian webhook: HMAC-authenticated, replay-safe, idempotent per tx hash', async () => {
  const u = await login(app);
  await u.kyc({ screening: 'clear' });
  const userId = (await db.query('SELECT id FROM users WHERE phone = $1', [u.phone])).rows[0].id;
  const body = JSON.stringify({ customer_ref: userId, network: 'base', tx_hash: '0x' + 'ab'.repeat(32), from_address: CLEAN, amount: '25' });
  const now = String(Math.floor(Date.now() / 1000));
  const send = (headers: Record<string, string>) => app.inject({
    method: 'POST', url: '/v1/webhooks/custody/deposits', payload: body, headers: { 'content-type': 'application/json', ...headers },
  });
  const secret = 'dev-only-webhook-secret';

  assert.equal((await send({})).statusCode, 401);
  assert.equal((await send({ 'x-timestamp': now, 'x-signature': signWebhook('wrong', now, body) })).statusCode, 401);
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await send({ 'x-timestamp': old, 'x-signature': signWebhook(secret, old, body) })).json().error, 'stale_webhook');
  const garbage = await app.inject({ method: 'POST', url: '/v1/webhooks/custody/deposits', payload: '{"x":1}',
    headers: { 'content-type': 'application/json' } });
  assert.equal(garbage.statusCode, 401, 'unauthenticated bodies are rejected before schema validation');

  const ok = await send({ 'x-timestamp': now, 'x-signature': signWebhook(secret, now, body) });
  assert.equal(ok.statusCode, 200, ok.body);
  const okBody = ok.json() as { disposition: string; replayed: boolean };
  assert.equal(okBody.disposition, 'credited');
  assert.equal(okBody.replayed, false);
  const again = await send({ 'x-timestamp': now, 'x-signature': signWebhook(secret, now, body) });
  assert.equal(again.json().replayed, true);
  assert.equal(await u.balance(), '25.000000');
});

t('global invariants hold after all crypto flows', async () => {
  const net = await db.query(`SELECT currency, sum(balance)::bigint AS s FROM accounts GROUP BY currency`);
  for (const r of net.rows) assert.equal(r.s, 0n, `${r.currency} does not net to zero`);
  const bad = await db.query(
    `SELECT txn_id FROM ledger_entries GROUP BY txn_id
      HAVING count(DISTINCT currency) > 2 OR (count(DISTINCT currency) = 2 AND NOT bool_or(currency = 'USDC'))`);
  assert.equal(bad.rowCount, 0);
});
