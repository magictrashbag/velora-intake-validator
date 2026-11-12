/**
 * Retroactive review when a crypto address is newly sanctioned (OFAC guidance: review past
 * transactions for connections to a listed address). Also provides the local denylist wrapper
 * that every address screening goes through.
 */
import { isNetwork, isValidAddress, normalizeAddress, type Network, type SanctionsScreener } from '@puente/core';
import type { Db } from './db.ts';
import { withTx } from './db.ts';
import { AppError } from './errors.ts';
import { audit } from './audit.ts';
import { openReviewCase } from './movement.ts';

/** Screener that consults our own denylist first; a hit is 'sanctioned' regardless of the vendor. */
export function withLocalDenylist(db: Db, inner: SanctionsScreener): SanctionsScreener {
  return {
    screenPerson: (p) => inner.screenPerson(p),
    async screenAddress(network, address) {
      const a = normalizeAddress(network, address);
      const hit = await db.query('SELECT id FROM sanctioned_addresses WHERE network = $1 AND address = $2', [network, a]);
      if (hit.rows[0]) return { risk: 'sanctioned', providerRef: `local-denylist:${hit.rows[0].id}` };
      return inner.screenAddress(network, a);
    },
  };
}

export interface ListingEntry { network: string; address: string; listed_on?: string }

export interface RetroResult {
  added: number;
  already_listed: number;
  exposed_users: string[];
  deposits_found: number;
  withdrawals_found: number;
  withdrawals_halted: string[];
}

export async function addSanctionedAddresses(
  db: Db, staffId: string, source: string, entries: ListingEntry[], note: string,
): Promise<RetroResult> {
  if (note.trim().length < 5) throw new AppError(400, 'note_required');
  const clean: { network: Network; address: string; listed_on: string | null }[] = [];
  for (const e of entries) {
    if (!isNetwork(e.network)) throw new AppError(400, 'network_not_supported', e.network);
    if (!isValidAddress(e.network, e.address)) throw new AppError(400, 'address_invalid', e.address);
    clean.push({ network: e.network, address: normalizeAddress(e.network, e.address), listed_on: e.listed_on ?? null });
  }

  return withTx(db, async (tx) => {
    const res: RetroResult = { added: 0, already_listed: 0, exposed_users: [], deposits_found: 0, withdrawals_found: 0, withdrawals_halted: [] };
    const users = new Set<string>();
    for (const e of clean) {
      const ins = await tx.query(
        `INSERT INTO sanctioned_addresses (network, address, source, listed_on, added_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (network, address) DO NOTHING RETURNING id`, [e.network, e.address, source, e.listed_on, staffId]);
      if (ins.rowCount) res.added++; else res.already_listed++;

      // Stop anything not yet confirmed on-chain to this address. Flagged rows are skipped by the
      // worker; a 'sending' row may already be with the custodian, so it is flagged for a human too.
      const halted = await tx.query(
        `UPDATE crypto_withdrawals SET needs_attention = true, last_error = 'destination newly sanctioned', updated_at = now()
          WHERE network = $1 AND address = $2 AND status IN ('queued','sending','broadcast') AND needs_attention = false
          RETURNING transfer_id, user_id`, [e.network, e.address]);
      for (const h of halted.rows) { res.withdrawals_halted.push(h.transfer_id); users.add(h.user_id); }

      const deps = await tx.query(`SELECT DISTINCT user_id, count(*) OVER () AS n FROM crypto_deposits WHERE network = $1 AND from_address = $2`, [e.network, e.address]);
      res.deposits_found += Number(deps.rows[0]?.n ?? 0);
      for (const d of deps.rows) users.add(d.user_id);
      const wds = await tx.query(`SELECT DISTINCT user_id, count(*) OVER () AS n FROM crypto_withdrawals WHERE network = $1 AND address = $2`, [e.network, e.address]);
      res.withdrawals_found += Number(wds.rows[0]?.n ?? 0);
      for (const w of wds.rows) users.add(w.user_id);
    }
    // One case per exposed customer. Past dealings before the listing were not violations, so we
    // review (not auto-freeze); a reviewer decides whether anything we still hold must be blocked.
    for (const u of users) await openReviewCase(tx, 'user', u, u, ['retro_sanctioned_address_exposure']);
    res.exposed_users = [...users];
    await audit(tx, { actor: null, action: 'sanctions.addresses_added', details: { staff: staffId, source, count: clean.length, note, ...res } });
    return res;
  });
}
