import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = await buildApp({ db, config });
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Kame API on :${config.port}${config.devMode ? ' (DEV MODE: dev routes + OTP echo enabled)' : ''}`);
