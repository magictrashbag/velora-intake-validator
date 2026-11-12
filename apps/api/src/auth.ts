import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();
export const otpHash = (pepper: string, phone: string, code: string) =>
  createHmac('sha256', pepper).update(`${phone}:${code}`).digest();

export const newOtpCode = () => randomInt(0, 1_000_000).toString().padStart(6, '0');
export const newSessionToken = () => randomBytes(32).toString('base64url');

export function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AuthUser { id: string; phone: string; status: string; kycTier: number; screening: string }

declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser }
}

export function requireAuth(db: Db) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new AppError(401, 'unauthenticated');
    const { rows } = await db.query(
      `SELECT u.id, u.phone, u.status, u.kyc_tier, u.screening
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.status <> 'closed'`,
      [sha256(h.slice(7))],
    );
    const u = rows[0];
    if (!u) throw new AppError(401, 'unauthenticated');
    req.user = { id: u.id, phone: u.phone, status: u.status, kycTier: u.kyc_tier, screening: u.screening };
  };
}
