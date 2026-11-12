import type { FastifyInstance } from 'fastify';
import { parseAmount, usdCentsEquivalent, MoneyError, formatAmount } from '@puente/core';
import type { Deps } from '../app.ts';
import { requireAuth } from '../auth.ts';
import { withTx } from '../db.ts';
import { AppError } from '../errors.ts';
import { lockWallet, postLedgerTxn } from '../ledger.ts';
import { executeGatedMovement } from '../movement.ts';

interface P2PBody { to_phone: string; amount: string; currency: 'USDC'; note?: string }

export async function transferRoutes(app: FastifyInstance, { db, config }: Deps) {
  app.post<{ Body: P2PBody }>('/v1/transfers', {
    preHandler: requireAuth(db),
    schema: {
      body: {
        type: 'object', required: ['to_phone', 'amount', 'currency'], additionalProperties: false,
        properties: {
          to_phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
          amount: { type: 'string', maxLength: 32 },
          currency: { type: 'string', enum: ['USDC'] },
          note: { type: 'string', maxLength: 140 },
        },
      },
    },
  }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string') throw new AppError(400, 'idempotency_key_required');
    const me = req.user!;
    let amount;
    try { amount = parseAmount(req.body.amount, req.body.currency); }
    catch (e) { if (e instanceof MoneyError) throw new AppError(400, 'invalid_amount', e.message); throw e; }

    const rec = await db.query('SELECT id FROM users WHERE phone = $1', [req.body.to_phone]);
    if (!rec.rows[0]) throw new AppError(404, 'recipient_not_found');
    const recipientId: string = rec.rows[0].id;
    if (recipientId === me.id) throw new AppError(400, 'cannot_send_to_self');

    const res = await withTx(db, (tx) => executeGatedMovement(tx, config, {
      kind: 'p2p',
      senderId: me.id,
      recipientId,
      currency: amount.currency,
      amountMinor: amount.minor,
      amountUsdCents: usdCentsEquivalent(amount)!,
      idempotencyKey: key,
      body: req.body,
      ip: req.ip,
      debit: { currency: amount.currency, minor: amount.minor },
      post: async (tx) => {
        // Lock in a stable order (by id) to avoid deadlocks between A->B and B->A.
        const [first, second] = [me.id, recipientId].sort();
        const a = await lockWallet(tx, first!, amount.currency);
        const b = await lockWallet(tx, second!, amount.currency);
        const from = first === me.id ? a : b;
        const to = first === me.id ? b : a;
        if (from.balance < amount.minor) throw new AppError(422, 'insufficient_funds');
        return postLedgerTxn(tx, 'p2p', `P2P ${formatAmount(amount, { trimZeros: true })} ${amount.currency}`, [
          { accountId: from.id, currency: amount.currency, amount: -amount.minor },
          { accountId: to.id, currency: amount.currency, amount: amount.minor },
        ]);
      },
    }));
    reply.code(res.status === 'denied' ? 403 : res.status === 'held_for_review' ? 202 : 201);
    return res;
  });
}
