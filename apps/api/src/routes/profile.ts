import type { FastifyInstance } from 'fastify';
import { DEFAULT_POLICY, formatAmount, type KycTier } from '@kame/core';
import type { Deps } from '../app.ts';
import { requireAuth } from '../auth.ts';
import { AppError } from '../errors.ts';
import { audit } from '../audit.ts';

const LOOKUPS_PER_HOUR = 30;
const usd = (cents: bigint) => formatAmount({ currency: 'USD', minor: cents });

/** "María José González Pérez" -> "María G." — enough to confirm the payee, not enough to dox. */
export function maskName(full: string | null): string | null {
  if (!full) return null;
  const parts = full.trim().split(/\s+/);
  const first = parts[0]!;
  const lastInitial = parts.length > 1 ? ` ${parts[surnameIndex(parts)]![0]!.toUpperCase()}.` : '';
  return first + lastInitial;
}

/**
 * Index of the surname people go by. Venezuelan legal names are usually "given given paternal
 * maternal": with 4+ words the paternal surname is second to last. With 2-3 words it's ambiguous
 * ("Ana María Pérez"), so use the last word. Once KYC returns given names and surnames as separate
 * fields, use those instead.
 */
export function surnameIndex(parts: string[]): number {
  return parts.length >= 4 ? parts.length - 2 : parts.length - 1;
}

export async function profileRoutes(app: FastifyInstance, { db }: Deps) {
  app.get('/v1/me', { onRequest: requireAuth(db) }, async (req) => {
    const u = (await db.query(
      `SELECT id, phone, legal_name, kyc_tier, status, country, created_at FROM users WHERE id = $1`, [req.user!.id])).rows[0];
    const lim = DEFAULT_POLICY.limits[u.kyc_tier as KycTier];
    return {
      id: u.id,
      phone: u.phone,
      name: u.legal_name,
      kyc_tier: u.kyc_tier,
      status: u.status,
      country: u.country,
      member_since: u.created_at.toISOString().slice(0, 10),
      limits: lim
        ? { per_transaction_usd: usd(lim.perTxnUsdCents), daily_usd: usd(lim.dailyUsdCents), monthly_usd: usd(lim.monthlyUsdCents) }
        : null,
      // What the QR code encodes: a public payment handle only. Scanning it prefills a send form;
      // it can never move money by itself.
      payment_uri: `kame://pagar?tel=${encodeURIComponent(u.phone)}`,
    };
  });

  /**
   * Confirmation of payee: before sending, show a MASKED name for the recipient's phone so the
   * payer can spot a wrong number or a scam. Rate-limited and audited to stop name harvesting.
   */
  app.get<{ Querystring: { phone: string } }>('/v1/recipients/lookup', {
    onRequest: requireAuth(db),
    schema: { querystring: { type: 'object', required: ['phone'], properties: { phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' } } } },
  }, async (req) => {
    const n = await db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = $1 AND action = 'recipient.lookup' AND created_at > now() - interval '1 hour'`,
      [req.user!.id]);
    if (n.rows[0].n >= LOOKUPS_PER_HOUR) throw new AppError(429, 'too_many_requests');
    await audit(db, { actor: req.user!.id, action: 'recipient.lookup', subject: req.query.phone, ip: req.ip });
    const r = await db.query(`SELECT legal_name, status FROM users WHERE phone = $1`, [req.query.phone]);
    const u = r.rows[0];
    // Same response for "no account" and "closed" so the endpoint doesn't reveal account state.
    if (!u || u.status === 'closed') return { found: false };
    return { found: true, display_name: maskName(u.legal_name) ?? 'Usuario Kame' };
  });
}
