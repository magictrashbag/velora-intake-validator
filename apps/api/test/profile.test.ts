import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db.ts';
import { maskName } from '../src/routes/profile.ts';
import { setup, login, verifiedUser, haveDb } from './helpers.ts';

let app: FastifyInstance;
let db: Db;
let teardown: () => Promise<void>;
before(async () => { if (haveDb) ({ app, db, teardown } = await setup()); });
after(async () => { if (haveDb) await teardown(); });
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !haveDb && 'DATABASE_URL not set' }, fn);

test('name masking', () => {
  assert.equal(maskName('María José González Pérez'), 'María G.', 'paternal surname for 4-word names');
  assert.equal(maskName('Luis Mendoza'), 'Luis M.');
  assert.equal(maskName('  Ana  '), 'Ana');
  assert.equal(maskName(null), null);
});

t('profile shows own details, tier limits and a payment-only QR payload', async () => {
  const u = await verifiedUser(app, 1);
  const r = await app.inject({ method: 'GET', url: '/v1/me', headers: u.h });
  assert.equal(r.statusCode, 200);
  const me = r.json();
  assert.equal(me.phone, u.phone);
  assert.equal(me.name, 'Ana María Pérez');
  assert.deepEqual(me.limits, { per_transaction_usd: '500.00', daily_usd: '500.00', monthly_usd: '2000.00' });
  assert.equal(me.payment_uri, `puente://pagar?tel=${encodeURIComponent(u.phone)}`);
  const anon = await login(app);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: anon.h })).json().limits, null, 'tier 0: no sending limits');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode, 401);
});

t('recipient lookup returns only a masked name, and is rate-limited', async () => {
  const a = await verifiedUser(app);
  const b = await verifiedUser(app);
  const r = await app.inject({ method: 'GET', url: `/v1/recipients/lookup?phone=${encodeURIComponent(b.phone)}`, headers: a.h });
  assert.deepEqual(r.json(), { found: true, display_name: 'Ana P.' });
  assert.ok(!JSON.stringify(r.json()).includes('María'), 'full name never exposed');
  const none = await app.inject({ method: 'GET', url: `/v1/recipients/lookup?phone=${encodeURIComponent('+584169990000')}`, headers: a.h });
  assert.deepEqual(none.json(), { found: false });
  let last = 200;
  for (let i = 0; i < 30; i++) {
    last = (await app.inject({ method: 'GET', url: `/v1/recipients/lookup?phone=${encodeURIComponent(b.phone)}`, headers: a.h })).statusCode;
  }
  assert.equal(last, 429);
});
