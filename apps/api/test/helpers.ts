import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createPool, type Db } from '../src/db.ts';
import { migrate } from '../src/migrate.ts';

const ADMIN_URL = process.env.DATABASE_URL;
export const haveDb = Boolean(ADMIN_URL);

/** Fresh, migrated database per test file; dropped afterwards. */
export async function setup(): Promise<{ app: FastifyInstance; db: Db; teardown: () => Promise<void> }> {
  const name = `kame_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  const db = createPool(url.toString());
  await migrate(db);
  const app = await buildApp({ db, config: loadConfig({ NODE_ENV: 'test', DATABASE_URL: url.toString() }) });
  return {
    app,
    db,
    teardown: async () => {
      await app.close();
      await db.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    },
  };
}

let phoneSeq = 0;
export async function login(app: FastifyInstance, phone = `+58412${String(1_000_000 + ++phoneSeq).slice(1)}`) {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { phone } });
  const code = s.json().dev_code;
  const v = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code } });
  const token = v.json().token as string;
  const h = { authorization: `Bearer ${token}` };
  return {
    phone,
    token,
    h,
    kyc: (body: object) => app.inject({ method: 'POST', url: '/v1/dev/kyc', headers: h, payload: body }),
    deposit: (amount: string, currency = 'USDC', from_address?: string) =>
      app.inject({ method: 'POST', url: '/v1/dev/deposit', headers: h,
        payload: { amount, currency, ...(from_address ? { from_address } : {}) } }),
    send: (to: string, amount: string, key: string = randomUUID()) =>
      app.inject({ method: 'POST', url: '/v1/transfers', headers: { ...h, 'idempotency-key': key },
        payload: { to_phone: to, amount, currency: 'USDC' } }),
    balance: async (currency = 'USDC') => {
      const w = await app.inject({ method: 'GET', url: '/v1/wallet', headers: h });
      return w.json().balances.find((b: any) => b.currency === currency).amount as string;
    },
  };
}

/** KYC-approved, screened, established (30-day-old) user. */
export async function verifiedUser(app: FastifyInstance, tier = 1) {
  const u = await login(app);
  await u.kyc({ kyc_tier: tier, screening: 'clear', legal_name: 'Ana María Pérez', age_days: 30 });
  return u;
}

export const CLEAN = '0x' + '1'.repeat(40);
export const SANCTIONED = '0x' + '2'.repeat(36) + 'dead';
export const HIGH_RISK = '0x' + '3'.repeat(36) + 'beef';

export function withdraw(app: FastifyInstance, u: { h: Record<string, string> }, body: object, key: string = randomUUID()) {
  return app.inject({ method: 'POST', url: '/v1/crypto/withdrawals', headers: { ...u.h, 'idempotency-key': key }, payload: body });
}
