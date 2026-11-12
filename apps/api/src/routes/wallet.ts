import type { FastifyInstance } from 'fastify';
import { CURRENCIES, formatAmount, type Currency } from '@puente/core';
import type { Deps } from '../app.ts';
import { requireAuth } from '../auth.ts';

export async function walletRoutes(app: FastifyInstance, { db }: Deps) {
  app.get('/v1/wallet', { preHandler: requireAuth(db) }, async (req) => {
    const u = req.user!;
    const acc = await db.query<{ id: string; currency: Currency; balance: bigint }>(
      `SELECT id, currency, balance FROM accounts WHERE owner_user_id = $1 ORDER BY currency = 'USDC' DESC, currency`, [u.id]);
    const recent = await db.query<{ id: bigint; currency: Currency; amount: bigint; kind: string; description: string; created_at: Date }>(
      `SELECT e.id, e.currency, e.amount, t.kind, t.description, e.created_at
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.txn_id
        WHERE e.account_id = ANY($1) ORDER BY e.id DESC LIMIT 20`,
      [acc.rows.map((a) => a.id)]);
    return {
      user: { id: u.id, phone: u.phone, kyc_tier: u.kycTier, status: u.status },
      balances: acc.rows.map((a) => ({
        currency: a.currency,
        label: CURRENCIES[a.currency].label,
        amount: formatAmount({ currency: a.currency, minor: a.balance }),
      })),
      activity: recent.rows.map((r) => ({
        id: r.id.toString(),
        kind: r.kind,
        description: r.description,
        currency: r.currency,
        amount: formatAmount({ currency: r.currency, minor: r.amount }),
        at: r.created_at.toISOString(),
      })),
    };
  });
}
