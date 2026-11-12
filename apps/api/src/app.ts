import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { MoneyError, type FxRateProvider, type SanctionsScreener } from '@puente/core';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { mockFxRates, mockScreener, mockSms, type SmsSender } from './providers/mock.ts';
import { authRoutes } from './routes/auth.ts';
import { walletRoutes } from './routes/wallet.ts';
import { transferRoutes } from './routes/transfers.ts';
import { fxRoutes } from './routes/fx.ts';
import { devRoutes } from './routes/dev.ts';
import { cryptoRoutes } from './routes/crypto.ts';

export interface Deps { db: Db; config: Config; sms: SmsSender; fx: FxRateProvider; screener: SanctionsScreener }

export async function buildApp(d: {
  db: Db; config: Config; sms?: SmsSender; fx?: FxRateProvider; screener?: SanctionsScreener;
}): Promise<FastifyInstance> {
  if (!d.config.devMode && (!d.sms || !d.fx || !d.screener)) {
    // Never fall back to mocks in production: a mock screener would clear every address.
    throw new Error('production requires real sms, fx and screener providers');
  }
  const deps: Deps = {
    db: d.db, config: d.config, sms: d.sms ?? mockSms, fx: d.fx ?? mockFxRates(), screener: d.screener ?? mockScreener,
  };
  const opts: FastifyServerOptions = {
    logger: d.config.devMode ? false : {
      // Never log credentials or OTP codes.
      redact: ['req.headers.authorization', 'req.headers["idempotency-key"]', 'req.body.code'],
    },
    bodyLimit: 16 * 1024,
    trustProxy: d.config.trustProxy,
  };
  const app = Fastify(opts);

  // Keep the raw body for webhook signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    if (body === '') return done(null, undefined);
    try { done(null, JSON.parse(body as string)); }
    catch { done(Object.assign(new Error('invalid JSON'), { statusCode: 400, validation: true }), undefined); }
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    if (err instanceof MoneyError) return reply.code(400).send({ error: 'invalid_amount', message: err.message });
    if (err.validation) return reply.code(400).send({ error: 'invalid_request', message: err.message });
    // Deadlock / serialization failure: nothing was committed; safe for the client to retry
    // with the SAME idempotency key.
    if (err.code === '40P01' || err.code === '40001') return reply.code(409).send({ error: 'retry' });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal_error' }); // never leak internals
  });

  app.get('/health', async () => ({ ok: true }));
  await authRoutes(app, deps);
  await walletRoutes(app, deps);
  await transferRoutes(app, deps);
  await fxRoutes(app, deps);
  await cryptoRoutes(app, deps);
  if (d.config.devMode) await devRoutes(app, deps);
  return app;
}
