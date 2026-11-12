// Usage: DATABASE_URL=... npm run staff -w @puente/api -- create <email> <reviewer|compliance_officer|admin>
import { createPool } from '../db.ts';
import { issueStaffToken, type StaffRole } from '../staff.ts';

const [cmd, email, role] = process.argv.slice(2);
const ROLES = ['reviewer', 'compliance_officer', 'admin'];
if (cmd !== 'create' || !email || !role || !ROLES.includes(role) || !process.env.DATABASE_URL) {
  console.error('usage: DATABASE_URL=... staff create <email> <reviewer|compliance_officer|admin>');
  process.exit(2);
}
const db = createPool(process.env.DATABASE_URL);
const { token } = await issueStaffToken(db, email, role as StaffRole);
console.log(`staff token for ${email} (${role}), valid 12h — shown once, store it in a password manager:\n${token}`);
await db.end();
