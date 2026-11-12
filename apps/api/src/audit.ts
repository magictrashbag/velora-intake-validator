import type { Tx, Db } from './db.ts';

export async function audit(
  q: Tx | Db,
  e: { actor?: string | null; action: string; subject?: string; details?: Record<string, unknown>; ip?: string },
) {
  await q.query(
    'INSERT INTO audit_log (actor_user_id, action, subject, details, ip) VALUES ($1,$2,$3,$4,$5)',
    [e.actor ?? null, e.action, e.subject ?? null, JSON.stringify(e.details ?? {}, jsonBigint), e.ip ?? null],
  );
}

export function jsonBigint(_k: string, v: unknown) {
  return typeof v === 'bigint' ? v.toString() : v;
}
