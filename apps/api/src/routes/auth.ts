import type { FastifyInstance } from 'fastify';
import type { Deps } from '../app.ts';
import { withTx } from '../db.ts';
import { AppError } from '../errors.ts';
import { audit } from '../audit.ts';
import { isBlockedPhone, phoneCountry } from '@puente/core';
import { newOtpCode, newSessionToken, otpHash, safeEqual, sha256, requireAuth } from '../auth.ts';

const PHONE = { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' } as const;
const MAX_CHALLENGES_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

export async function authRoutes(app: FastifyInstance, { db, config, sms }: Deps) {
  app.post<{ Body: { phone: string } }>('/v1/auth/otp/start', {
    schema: { body: { type: 'object', required: ['phone'], additionalProperties: false, properties: { phone: PHONE } } },
  }, async (req) => {
    const { phone } = req.body;
    if (isBlockedPhone(phone)) {
      await audit(db, { action: 'auth.blocked_jurisdiction', subject: phone, ip: req.ip });
      throw new AppError(403, 'jurisdiction_not_supported');
    }
    const recent = await db.query(
      `SELECT count(*)::int AS n FROM otp_challenges WHERE phone = $1 AND created_at > now() - interval '1 hour'`,
      [phone],
    );
    if (recent.rows[0].n >= MAX_CHALLENGES_PER_HOUR) throw new AppError(429, 'too_many_requests');
    const code = newOtpCode();
    await db.query(
      `INSERT INTO otp_challenges (phone, code_hash, expires_at) VALUES ($1,$2, now() + interval '5 minutes')`,
      [phone, otpHash(config.otpPepper, phone, code)],
    );
    await sms.sendOtp(phone, code);
    await audit(db, { action: 'auth.otp_started', subject: phone, ip: req.ip });
    return config.devMode ? { sent: true, dev_code: code } : { sent: true };
  });

  app.post<{ Body: { phone: string; code: string } }>('/v1/auth/otp/verify', {
    schema: {
      body: {
        type: 'object', required: ['phone', 'code'], additionalProperties: false,
        properties: { phone: PHONE, code: { type: 'string', pattern: '^[0-9]{6}$' } },
      },
    },
  }, async (req) => {
    const { phone, code } = req.body;
    // Attempt accounting must survive a failed verify, so it commits separately from login.
    const ch = await db.query(
      `UPDATE otp_challenges SET attempts = attempts + 1
        WHERE id = (SELECT id FROM otp_challenges
                     WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
                     ORDER BY created_at DESC LIMIT 1)
        RETURNING id, code_hash, attempts`,
      [phone],
    );
    const c = ch.rows[0];
    if (!c || c.attempts > MAX_ATTEMPTS || !safeEqual(c.code_hash, otpHash(config.otpPepper, phone, code))) {
      await audit(db, { action: 'auth.otp_failed', subject: phone, ip: req.ip });
      throw new AppError(401, 'invalid_code');
    }

    return withTx(db, async (tx) => {
      const consumed = await tx.query(
        'UPDATE otp_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [c.id]);
      if (!consumed.rowCount) throw new AppError(401, 'invalid_code');

      const ins = await tx.query(
        `INSERT INTO users (phone, country) VALUES ($1, $2) ON CONFLICT (phone) DO NOTHING RETURNING id`,
        [phone, phoneCountry(phone)]);
      let userId: string;
      if (ins.rows[0]) {
        userId = ins.rows[0].id;
        await tx.query(
          `INSERT INTO accounts (owner_user_id, kind, currency) VALUES ($1,'user_wallet','USDC'), ($1,'user_wallet','VES')`,
          [userId]);
        await audit(tx, { actor: userId, action: 'user.created', ip: req.ip });
      } else {
        userId = (await tx.query('SELECT id FROM users WHERE phone = $1', [phone])).rows[0].id;
      }
      const token = newSessionToken();
      await tx.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3))`,
        [sha256(token), userId, config.sessionTtlHours]);
      await audit(tx, { actor: userId, action: 'auth.login', ip: req.ip });
      return { token, user_id: userId, expires_in_hours: config.sessionTtlHours };
    });
  });

  app.post('/v1/auth/logout', { preHandler: requireAuth(db) }, async (req) => {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1',
      [sha256(req.headers.authorization!.slice(7))]);
    await audit(db, { actor: req.user!.id, action: 'auth.logout', ip: req.ip });
    return { ok: true };
  });
}
