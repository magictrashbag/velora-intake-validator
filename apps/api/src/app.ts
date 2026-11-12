import Fastify, { type FastifyInstance } from 'fastify';
import type { FxRateProvider } from '@puente/core';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { mockFxRates, mockSms, type SmsSender } from './providers/mock.ts';
import { authRoutes } from './routes/auth.ts';
import { walletRoutes } from './routes/wallet.ts';
import { transferRoutes } from './routes/transfers.ts';
import { fxRoutes } from './routes/fx.ts';
import { devRoutes } from './routes/dev.ts';

export interface Deps { db: Db; config: Config; sms: SmsSender; fx: FxRateProvider }

export async function buildApp(d: { db: Db; config: Config; sms?: SmsSender; fx?: FxRateProvider }): Promise<FastifyInstance> {
  const deps: Deps = { db: d.db, config: d.config, sms: d.sms ?? mockSms, fx: d.fx ?? mockFxRates() };
  const app = Fastify({
    logger: d.config.devMode ? false : {
      // Never log credentials or OTP codes.
      redact: ['req.headers.authorization', 'req.headers["idempotency-key"]', 'req.body.code'],
    },
    bodyLimit: 16 * 1024,
    trustProxy: true,
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
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
  if (d.config.devMode) await devRoutes(app, deps);
  return app;
}
