import pg from 'pg';

// bigint columns come back as strings by default; parse them to BigInt so money never
// passes through a JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => BigInt(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/** Run `fn` in a SERIALIZABLE-safe transaction; rolls back on any throw. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
