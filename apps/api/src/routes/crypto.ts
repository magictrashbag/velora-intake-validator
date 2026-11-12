import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  parseAmount, usdCentsEquivalent, isNetwork, isValidAddress, normalizeAddress, MoneyError, formatAmount, NETWORKS,
} from '@puente/core';
import type { Deps } from '../app.ts';
import { requireAuth, safeEqual } from '../auth.ts';
import { withTx } from '../db.ts';
import { AppError } from '../errors.ts';
import { lockWallet, postLedgerTxn, systemAccount } from '../ledger.ts';
import { executeGatedMovement } from '../movement.ts';
import { processCryptoDeposit } from '../deposits.ts';
import { settleWithdrawal } from '../withdrawals.ts';

interface WithdrawalBody {
  network: string;
  address: string;
  amount: string;
  travel_rule?: { beneficiary_name: string; wallet_type: 'self_hosted' | 'vasp'; vasp_name?: string };
}

export async function cryptoRoutes(app: FastifyInstance, { db, config, screener }: Deps) {
  app.post<{ Body: WithdrawalBody }>('/v1/crypto/withdrawals', {
    preHandler: requireAuth(db),
    schema: {
      body: {
        type: 'object', required: ['network', 'address', 'amount'], additionalProperties: false,
        properties: {
          network: { type: 'string', maxLength: 20 },
          address: { type: 'string', maxLength: 100 },
          amount: { type: 'string', maxLength: 32 },
          travel_rule: {
            type: 'object', required: ['beneficiary_name', 'wallet_type'], additionalProperties: false,
            properties: {
              beneficiary_name: { type: 'string', maxLength: 200 },
              wallet_type: { type: 'string', enum: ['self_hosted', 'vasp'] },
              vasp_name: { type: 'string', maxLength: 200 },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string') throw new AppError(400, 'idempotency_key_required');
    const me = req.user!;
    const b = req.body;
    if (!isNetwork(b.network)) throw new AppError(400, 'network_not_supported', `supported: ${NETWORKS.join(', ')}`);
    if (!isValidAddress(b.network, b.address)) throw new AppError(400, 'address_invalid');
    const network = b.network;
    const address = normalizeAddress(network, b.address);
    let amount;
    try { amount = parseAmount(b.amount, 'USDC'); }
    catch (e) { if (e instanceof MoneyError) throw new AppError(400, 'invalid_amount', e.message); throw e; }

    // Screen before opening the DB transaction (network call), and keep the evidence.
    const scr = await screener.screenAddress(network, address);
    await db.query('INSERT INTO address_screenings (network, address, risk, provider_ref) VALUES ($1,$2,$3,$4)',
      [network, address, scr.risk, scr.providerRef]);

    const res = await withTx(db, (tx) => executeGatedMovement(tx, config, {
      kind: 'crypto_withdrawal',
      senderId: me.id,
      currency: 'USDC',
      amountMinor: amount.minor,
      amountUsdCents: usdCentsEquivalent(amount)!,
      idempotencyKey: key,
      body: b,
      counterpartyAddress: { network, address, risk: scr.risk },
      debit: { currency: 'USDC', minor: amount.minor },
      details: { network, address },
      ...(b.travel_rule ? {
        travelRuleBeneficiary: {
          beneficiaryName: b.travel_rule.beneficiary_name,
          beneficiaryWalletType: b.travel_rule.wallet_type,
          ...(b.travel_rule.vasp_name ? { beneficiaryVaspName: b.travel_rule.vasp_name } : {}),
        },
      } : {}),
      ip: req.ip,
      post: async (tx) => {
        const w = await lockWallet(tx, me.id, 'USDC');
        if (w.balance < amount.minor) throw new AppError(422, 'insufficient_funds');
        return postLedgerTxn(tx, 'crypto_withdrawal', `Withdraw ${formatAmount(amount, { trimZeros: true })} USDC (${network})`, [
          { accountId: w.id, currency: 'USDC', amount: -amount.minor },
          { accountId: await systemAccount(tx, 'payout_clearing', 'USDC'), currency: 'USDC', amount: amount.minor },
        ]);
      },
      // Outbox: the "send on-chain" instruction commits atomically with the debit. A worker
      // calls CustodyProvider.withdraw with transfer_id as the idempotency key.
      afterRecord: async (tx, transferId, status) => {
        if (status !== 'posted') return;
        await tx.query(
          `INSERT INTO crypto_withdrawals (transfer_id, user_id, network, address, amount_minor) VALUES ($1,$2,$3,$4,$5)`,
          [transferId, me.id, network, address, amount.minor.toString()]);
      },
    }));
    reply.code(res.status === 'denied' ? 403 : res.status === 'held_for_review' ? 202 : 201);
    return res;
  });

  /**
   * Custodian webhook: a USDC deposit landed. Authenticated by HMAC-SHA256 over
   * `${timestamp}.${rawBody}` with a shared secret; stale timestamps are rejected (replay defence),
   * and (network, tx_hash) makes processing idempotent.
   */
  app.post<{ Body: { customer_ref: string; network: string; tx_hash: string; log_index: number; from_address: string; amount: string } }>(
    '/v1/webhooks/custody/deposits', {
      // Authenticate BEFORE validating the body, so unauthenticated callers learn nothing.
      preValidation: async (req) =>
        verifyWebhook(config.custodyWebhookSecret, req.headers['x-timestamp'], req.headers['x-signature'], (req as any).rawBody),
      schema: {
        body: {
          type: 'object', required: ['customer_ref', 'network', 'tx_hash', 'log_index', 'from_address', 'amount'], additionalProperties: false,
          properties: {
            customer_ref: { type: 'string', format: 'uuid' },
            network: { type: 'string', maxLength: 20 },
            tx_hash: { type: 'string', minLength: 10, maxLength: 120 },
            log_index: { type: 'integer', minimum: 0, maximum: 1000000 },
            from_address: { type: 'string', maxLength: 100 },
            amount: { type: 'string', maxLength: 32 },
          },
        },
      },
    }, async (req) => {
      const b = req.body;
      if (!isNetwork(b.network)) throw new AppError(400, 'network_not_supported');
      if (!isValidAddress(b.network, b.from_address)) throw new AppError(400, 'address_invalid');
      return processCryptoDeposit(db, config, screener, {
        userId: b.customer_ref, network: b.network, txHash: b.tx_hash, logIndex: b.log_index,
        fromAddress: b.from_address, amount: b.amount,
      });
    });

  /** Custodian webhook: final status of an on-chain withdrawal. Same HMAC scheme as deposits. */
  app.post<{ Body: { transfer_id: string; status: 'confirmed' | 'failed'; provider_ref: string; chain_tx_hash?: string; failure_reason?: string } }>(
    '/v1/webhooks/custody/withdrawals', {
      preValidation: async (req) =>
        verifyWebhook(config.custodyWebhookSecret, req.headers['x-timestamp'], req.headers['x-signature'], (req as any).rawBody),
      schema: {
        body: {
          type: 'object', required: ['transfer_id', 'status', 'provider_ref'], additionalProperties: false,
          properties: {
            transfer_id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['confirmed', 'failed'] },
            provider_ref: { type: 'string', maxLength: 200 },
            chain_tx_hash: { type: 'string', maxLength: 120 },
            failure_reason: { type: 'string', maxLength: 500 },
          },
        },
      },
    }, async (req) => settleWithdrawal(db, req.body));
}

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyWebhook(secret: string, ts: unknown, sig: unknown, rawBody: unknown) {
  if (typeof ts !== 'string' || typeof sig !== 'string' || typeof rawBody !== 'string') throw new AppError(401, 'bad_signature');
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) throw new AppError(401, 'stale_webhook');
  const expected = Buffer.from(signWebhook(secret, ts, rawBody));
  if (!safeEqual(expected, Buffer.from(sig))) throw new AppError(401, 'bad_signature');
}
