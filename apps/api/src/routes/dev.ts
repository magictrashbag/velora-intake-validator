import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { parseAmount, isNetwork } from '@puente/core';
import type { Deps } from '../app.ts';
import { requireAuth } from '../auth.ts';
import { withTx } from '../db.ts';
import { audit } from '../audit.ts';
import { AppError } from '../errors.ts';
import { lockWallet, postLedgerTxn, systemAccount } from '../ledger.ts';
import { processCryptoDeposit } from '../deposits.ts';

/**
 * DEVELOPMENT ONLY — never registered unless config.devMode. Simulates what partners will do
 * in production (custody deposit webhook, KYC approval, Bs partner funding).
 */
export async function devRoutes(app: FastifyInstance, { db, config, screener }: Deps) {
  app.post<{ Body: { amount: string; currency?: 'USDC' | 'VES'; network?: string; from_address?: string } }>('/v1/dev/deposit', {
    onRequest: requireAuth(db),
    schema: {
      body: {
        type: 'object', required: ['amount'], additionalProperties: false,
        properties: {
          amount: { type: 'string' },
          currency: { type: 'string', enum: ['USDC', 'VES'] },
          network: { type: 'string' },
          from_address: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const currency = req.body.currency ?? 'USDC';
    if (currency === 'USDC') {
      // Same code path as the real custodian webhook, including address screening.
      const network = req.body.network ?? 'polygon';
      if (!isNetwork(network)) throw new AppError(400, 'network_not_supported');
      return processCryptoDeposit(db, config, screener, {
        userId: req.user!.id,
        network,
        txHash: '0x' + randomBytes(32).toString('hex'),
        logIndex: 0,
        fromAddress: req.body.from_address ?? '0x' + '1'.repeat(40),
        amount: req.body.amount,
      });
    }
    const amt = parseAmount(req.body.amount, currency);
    await withTx(db, async (tx) => {
      const w = await lockWallet(tx, req.user!.id, amt.currency);
      await postLedgerTxn(tx, 'deposit', `Simulated Bs deposit (dev)`, [
        { accountId: await systemAccount(tx, 'custody_float', amt.currency), currency: amt.currency, amount: -amt.minor },
        { accountId: w.id, currency: amt.currency, amount: amt.minor },
      ]);
      await audit(tx, { actor: req.user!.id, action: 'dev.deposit', details: { amount: req.body.amount, currency } });
    });
    return { disposition: 'credited' };
  });

  app.post<{ Body: { kyc_tier?: 0 | 1 | 2; screening?: string; status?: string; legal_name?: string; country?: string; age_days?: number } }>('/v1/dev/kyc', {
    onRequest: requireAuth(db),
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          kyc_tier: { type: 'integer', enum: [0, 1, 2] },
          screening: { type: 'string', enum: ['clear', 'pending', 'potential_match', 'confirmed_match'] },
          status: { type: 'string', enum: ['active', 'frozen'] },
          legal_name: { type: 'string', minLength: 2, maxLength: 200 },
          country: { type: 'string', pattern: '^[A-Z]{2}$' },
          age_days: { type: 'integer', minimum: 0, maximum: 3650 },
        },
      },
    },
  }, async (req) => {
    const b = req.body;
    await db.query(
      `UPDATE users SET kyc_tier = coalesce($2, kyc_tier), screening = coalesce($3, screening), status = coalesce($4, status),
                        legal_name = coalesce($5, legal_name), country = coalesce($6, country),
                        created_at = CASE WHEN $7::int IS NULL THEN created_at ELSE now() - make_interval(days => $7::int) END
        WHERE id = $1`,
      [req.user!.id, b.kyc_tier ?? null, b.screening ?? null, b.status ?? null, b.legal_name ?? null, b.country ?? null, b.age_days ?? null]);
    await audit(db, { actor: req.user!.id, action: 'dev.kyc_set', details: b });
    return { ok: true };
  });
}
