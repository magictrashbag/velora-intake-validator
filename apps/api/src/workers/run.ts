// Withdrawal worker loop. Usage: DATABASE_URL=... NODE_ENV=development npm run worker -w @puente/api
import { createPool } from '../db.ts';
import { mockCustody } from '../providers/mock.ts';
import { runWithdrawalWorker } from './withdrawals.ts';

if (process.env.NODE_ENV !== 'development') {
  console.error('No production custody provider is integrated yet; refusing to run with a mock.');
  process.exit(1);
}
const db = createPool(process.env.DATABASE_URL!);
const custody = mockCustody().provider;
for (;;) {
  const r = await runWithdrawalWorker(db, custody);
  if (r.claimed) console.log(new Date().toISOString(), r);
  await new Promise((ok) => setTimeout(ok, 5_000));
}
