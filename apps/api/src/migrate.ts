import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool, withTx, type Db } from './db.ts';
import { loadConfig } from './config.ts';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    const done = await db.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (done.rowCount) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
    await withTx(db, async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    });
    log(`applied ${name}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool(loadConfig().databaseUrl);
  migrate(db, console.log)
    .then(() => db.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
