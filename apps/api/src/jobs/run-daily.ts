// Usage: DATABASE_URL=... NODE_ENV=development npm run jobs:daily -w @puente/api
// Exit code 1 if any check failed, so the scheduler (cron/K8s CronJob) alerts.
import { createPool } from '../db.ts';
import { mockCustody, mockScreener } from '../providers/mock.ts';
import { jsonBigint } from '../audit.ts';
import { runDailyJobs } from './daily.ts';

if (process.env.NODE_ENV !== 'development') {
  console.error('No production custody/screening providers are integrated yet; refusing to run with mocks.');
  process.exit(1);
}
const db = createPool(process.env.DATABASE_URL!);
const report = await runDailyJobs(db, { custody: mockCustody().provider, screener: mockScreener });
console.log(JSON.stringify(report, jsonBigint, 2));
await db.end();
process.exit(report.ok ? 0 : 1);
