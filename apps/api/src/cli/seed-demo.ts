/**
 * DEMO DATA for local development. Creates two customers with balances and history, one transfer
 * held for review, and staff logins for the review console. Refuses to run outside development.
 *
 *   npm run seed
 */
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { createPool } from '../db.ts';
import { issueStaffToken } from '../staff.ts';

const config = loadConfig();
if (!config.devMode) {
  console.error('seed-demo only runs with NODE_ENV=development.');
  process.exit(1);
}
const db = createPool(config.databaseUrl);
const app = await buildApp({ db, config });

const CUSTOMERS = [
  { phone: '+584121234567', name: 'Daniela Fernanda Rojas Márquez' },
  { phone: '+584249876543', name: 'Luis Alberto Mendoza Pérez' },
  { phone: '+584145550123', name: 'Carla MAYBE Ejemplo' }, // the mock screener flags "MAYBE" names
];

async function session(phone: string) {
  const s = await app.inject({ method: 'POST', url: '/v1/auth/otp/start', payload: { phone } });
  const v = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code: s.json().dev_code } });
  return { authorization: `Bearer ${v.json().token}` };
}
const post = (h: Record<string, string>, url: string, payload: object, key?: string) =>
  app.inject({ method: 'POST', url, headers: key ? { ...h, 'idempotency-key': key } : h, payload });

const already = await db.query('SELECT 1 FROM users WHERE phone = $1', [CUSTOMERS[0]!.phone]);
if (already.rowCount) {
  console.log('Demo customers already exist; issuing fresh staff logins only.\n');
} else {
  const [a, b, c] = await Promise.all(CUSTOMERS.map((x) => session(x.phone)));
  for (const [h, x] of [[a, CUSTOMERS[0]], [b, CUSTOMERS[1]], [c, CUSTOMERS[2]]] as const) {
    await post(h!, '/v1/dev/kyc', { kyc_tier: 1, screening: x!.name.includes('MAYBE') ? 'potential_match' : 'clear', legal_name: x!.name, age_days: 60 });
  }
  await post(a!, '/v1/dev/deposit', { amount: '320' });
  await post(b!, '/v1/dev/deposit', { amount: '150' });
  await post(b!, '/v1/transfers', { to_phone: CUSTOMERS[0]!.phone, amount: '45', currency: 'USDC' }, randomUUID());
  await post(a!, '/v1/transfers', { to_phone: CUSTOMERS[1]!.phone, amount: '12.50', currency: 'USDC' }, randomUUID());
  const q = await post(a!, '/v1/fx/quotes', { sell: 'USDC', buy: 'VES', amount: '40' });
  await post(a!, `/v1/fx/quotes/${q.json().quote_id}/execute`, {});
  // Goes to review: the recipient is a potential sanctions-screening match.
  await post(b!, '/v1/transfers', { to_phone: CUSTOMERS[2]!.phone, amount: '20', currency: 'USDC' }, randomUUID());
}

const r1 = await issueStaffToken(db, 'reviewer1@kame.local', 'reviewer');
const r2 = await issueStaffToken(db, 'reviewer2@kame.local', 'reviewer');
const co = await issueStaffToken(db, 'compliance@kame.local', 'compliance_officer');

console.log(`Demo ready (all data is fictional).

Customer app: log in with any of these phones. In development the 6-digit code is shown on screen.
${CUSTOMERS.map((c) => `  ${c.phone}   ${c.name}`).join('\n')}

Review console: http://localhost:${config.port}/staff  (paste a token; valid 12 hours)
  reviewer 1:          ${r1.token}
  reviewer 2:          ${r2.token}
  compliance officer:  ${co.token}
Approving needs two different staff, so use reviewer 1, then reviewer 2.
`);
await app.close();
await db.end();
