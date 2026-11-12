import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { newSessionToken, sha256 } from './auth.ts';

export type StaffRole = 'reviewer' | 'compliance_officer' | 'admin';
export interface StaffUser { id: string; email: string; role: StaffRole }

declare module 'fastify' {
  interface FastifyRequest { staff?: StaffUser }
}

/**
 * Staff authenticate with their own tokens, in their own table, on their own route prefix.
 * A customer token can never act as staff and vice versa.
 * Production: replace token issuance with SSO + hardware-key MFA and short sessions.
 */
export function requireStaff(db: Db, roles: readonly StaffRole[] = ['reviewer', 'compliance_officer', 'admin']) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new AppError(401, 'unauthenticated');
    const { rows } = await db.query(
      `SELECT s.id, s.email, s.role FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id
        WHERE ss.token_hash = $1 AND ss.revoked_at IS NULL AND ss.expires_at > now() AND s.status = 'active'`,
      [sha256(h.slice(7))]);
    if (!rows[0]) throw new AppError(401, 'unauthenticated');
    if (!roles.includes(rows[0].role)) throw new AppError(403, 'forbidden');
    req.staff = rows[0];
  };
}

/** Create (or re-activate) a staff member and issue a session token. Used by the CLI and tests. */
export async function issueStaffToken(db: Db, email: string, role: StaffRole, ttlHours = 12): Promise<{ staffId: string; token: string }> {
  const s = await db.query<{ id: string }>(
    `INSERT INTO staff (email, role) VALUES ($1,$2)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, status = 'active' RETURNING id`, [email, role]);
  const token = newSessionToken();
  await db.query(
    `INSERT INTO staff_sessions (token_hash, staff_id, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3))`,
    [sha256(token), s.rows[0]!.id, ttlHours]);
  return { staffId: s.rows[0]!.id, token };
}
