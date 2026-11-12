import type { FastifyInstance } from 'fastify';
import { applySpreadBps, convert, formatAmount, parseAmount, parseRate, usdCentsEquivalent, MoneyError, type Currency } from '@puente/core';
import type { Deps } from '../app.ts';
import { requireAuth } from '../auth.ts';
import { withTx } from '../db.ts';
import { AppError } from '../errors.ts';
import { lockWallet, postLedgerTxn, systemAccount } from '../ledger.ts';
import { executeGatedMovement } from '../movement.ts';

/** Bs <-> USD exchange against the house FX inventory, at a firm, short-lived quote. */
export async function fxRoutes(app: FastifyInstance, { db, config, fx }: Deps) {
  app.post<{ Body: { sell: Currency; buy: Currency; amount: string } }>('/v1/fx/quotes', {
    onRequest: requireAuth(db),
    schema: {
      body: {
        type: 'object', required: ['sell', 'buy', 'amount'], additionalProperties: false,
        properties: {
          sell: { type: 'string', enum: ['USDC', 'VES'] },
          buy: { type: 'string', enum: ['USDC', 'VES'] },
          amount: { type: 'string', maxLength: 32 },
        },
      },
    },
  }, async (req, reply) => {
    const { sell, buy } = req.body;
    if (sell === buy) throw new AppError(400, 'same_currency');
    let amount;
    try { amount = parseAmount(req.body.amount, sell); }
    catch (e) { if (e instanceof MoneyError) throw new AppError(400, 'invalid_amount', e.message); throw e; }

    const mid = await fx.midRate('USDC', 'VES');
    const midRate = parseRate('USDC', 'VES', mid.rate);
    const customerRate = applySpreadBps(midRate, config.fxSpreadBps, sell === 'USDC' ? 'base' : 'quote');
    const out = convert(amount, customerRate);
    if (out.minor <= 0n) throw new AppError(400, 'amount_too_small');

    const { rows } = await db.query(
      `INSERT INTO fx_quotes (user_id, sell_currency, buy_currency, sell_minor, buy_minor, mid_rate, spread_bps, rate_source, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9)) RETURNING id, expires_at`,
      [req.user!.id, sell, buy, amount.minor.toString(), out.minor.toString(), mid.rate, config.fxSpreadBps, mid.source, config.fxQuoteTtlSeconds]);
    reply.code(201);
    return {
      quote_id: rows[0].id,
      sell: { currency: sell, amount: formatAmount(amount) },
      buy: { currency: buy, amount: formatAmount(out) },
      mid_rate: mid.rate,
      spread_bps: config.fxSpreadBps,
      expires_at: rows[0].expires_at.toISOString(),
    };
  });

  app.post<{ Params: { id: string } }>('/v1/fx/quotes/:id/execute', {
    onRequest: requireAuth(db),
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    const me = req.user!;
    const res = await withTx(db, async (tx) => {
      const q = (await tx.query(
        `SELECT id, sell_currency, buy_currency, sell_minor, buy_minor, expires_at > now() AS live
           FROM fx_quotes WHERE id = $1 AND user_id = $2`, [req.params.id, me.id])).rows[0];
      if (!q) throw new AppError(404, 'quote_not_found');
      const sell = q.sell_currency as Currency;
      const buy = q.buy_currency as Currency;
      const sellMinor: bigint = q.sell_minor;
      const buyMinor: bigint = q.buy_minor;
      const usdSide = sell === 'USDC' ? { currency: sell, minor: sellMinor } : { currency: buy, minor: buyMinor };

      return executeGatedMovement(tx, config, {
        kind: 'fx',
        senderId: me.id,
        currency: sell,
        amountMinor: sellMinor,
        amountUsdCents: usdCentsEquivalent(usdSide)!,
        // One execution per quote, enforced by the transfers UNIQUE(sender, idempotency_key).
        idempotencyKey: `fxq:${q.id}`,
        body: { quote_id: q.id },
        ip: req.ip,
        debit: { currency: sell, minor: sellMinor },
        // A held trade executes later at THIS firm quote: the customer accepted these amounts,
        // and the house carries the FX risk during review.
        details: { quote_id: q.id, sell, sell_minor: sellMinor.toString(), buy, buy_minor: buyMinor.toString() },
        precheck: async () => { if (!q.live) throw new AppError(409, 'quote_expired'); },
        post: async (tx) => {
          const from = await lockWallet(tx, me.id, sell);
          const to = await lockWallet(tx, me.id, buy);
          if (from.balance < sellMinor) throw new AppError(422, 'insufficient_funds');
          // Lock the shared FX inventory rows in a FIXED order (by currency) so opposite-direction
          // trades can't deadlock on them.
          await tx.query(
            `SELECT id FROM accounts WHERE owner_user_id IS NULL AND kind = 'fx_inventory' AND currency = ANY($1)
              ORDER BY currency FOR NO KEY UPDATE`, [[sell, buy]]);
          return postLedgerTxn(tx, 'fx', `Exchange ${sell}->${buy}`, [
            { accountId: from.id, currency: sell, amount: -sellMinor },
            { accountId: await systemAccount(tx, 'fx_inventory', sell), currency: sell, amount: sellMinor },
            { accountId: await systemAccount(tx, 'fx_inventory', buy), currency: buy, amount: -buyMinor },
            { accountId: to.id, currency: buy, amount: buyMinor },
          ]);
        },
      });
    });
    reply.code(res.status === 'denied' ? 403 : res.status === 'held_for_review' ? 202 : 201);
    return res;
  });
}
