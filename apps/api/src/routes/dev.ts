import type { FastifyInstance } from 'fastify';
import { parseAmount } from '@puente/core';
import type { Deps } from '../app.ts';
import { requireAuth } from '../auth.ts';
import { withTx } from '../db.ts';
import { audit } from '../audit.ts';
import { lockWallet, postLedgerTxn, systemAccount } from '../ledger.ts';

/**
 * DEVELOPMENT ONLY — never registered unless config.devMode. Simulates what partner
 * webhooks (custody deposit confirmed, KYC approved) will do in production.
 */
export async function devRoutes(app: FastifyInstance, { db }: Deps) {
  app.post<{ Body: { amount: string; currency?: 'USDC' | 'VES' } }>('/v1/dev/deposit', {
    preHandler: requireAuth(db),
    schema: { body: { type: 'object', required: ['amount'], properties: { amount: { type: 'string' }, currency: { type: 'string', enum: ['USDC', 'VES'] } } } },
  }, async (req) => {
    const amt = parseAmount(req.body.amount, req.body.currency ?? 'USDC');
    await withTx(db, async (tx) => {
      const w = await lockWallet(tx, req.user!.id, amt.currency);
      await postLedgerTxn(tx, 'deposit', `Simulated deposit (dev)`, [
        { accountId: await systemAccount(tx, 'custody_float', amt.currency), currency: amt.currency, amount: -amt.minor },
        { accountId: w.id, currency: amt.currency, amount: amt.minor },
      ]);
      await audit(tx, { actor: req.user!.id, action: 'dev.deposit', details: { amount: req.body.amount } });
    });
    return { ok: true };
  });

  app.post<{ Body: { kyc_tier?: 0 | 1 | 2; screening?: string; status?: string } }>('/v1/dev/kyc', {
    preHandler: requireAuth(db),
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          kyc_tier: { type: 'integer', enum: [0, 1, 2] },
          screening: { type: 'string', enum: ['clear', 'pending', 'potential_match', 'confirmed_match'] },
          status: { type: 'string', enum: ['active', 'frozen'] },
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    await db.query(
      `UPDATE users SET kyc_tier = coalesce($2, kyc_tier), screening = coalesce($3, screening), status = coalesce($4, status) WHERE id = $1`,
      [req.user!.id, b.kyc_tier ?? null, b.screening ?? null, b.status ?? null]);
    await audit(db, { actor: req.user!.id, action: 'dev.kyc_set', details: b });
    return { ok: true };
  });
}
