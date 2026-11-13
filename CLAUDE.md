# Kame — notes for Claude Code

Kame is a USD-stablecoin wallet for Venezuela: P2P transfers, Bs ↔ USD exchange (always via USDC), on-chain USDC deposits/withdrawals, remittances (planned) and payments. It's compliance-first; read `docs/COMPLIANCE.md` and `docs/ARCHITECTURE.md` before changing anything that moves money.

## Layout
- `packages/core`: pure TS domain logic: money (bigint minor units), FX, the **compliance gate** (`compliance.ts`), USDC routing, partner interfaces.
- `apps/api`: Fastify + Postgres. All money movement goes through `src/movement.ts` (`executeGatedMovement`). Review engine in `src/review.ts`, staff console UI in `src/console/`, withdrawal worker in `src/workers/`, daily job in `src/jobs/daily.ts`.
- `apps/mobile`: Expo SDK 58 app (Spanish UI). See `apps/mobile/AGENTS.md`.
- `db/migrations`: append-only migrations. Never edit an applied migration; add a new one.

## Commands (repo root)
- `npm run db:up` / `npm run db:down`: Postgres in Docker. `npm run db:migrate`, then `npm run seed` for demo data and staff tokens.
- `npm run dev:api` (http://localhost:3000, console at `/staff`), `npm run dev:web` (browser preview), `npm run dev:mobile` (Expo Go).
- `npm run typecheck` and `npm test`. API tests need Postgres (`DATABASE_URL` from `.env`). Run both before calling work done.
- Windows one-shot setup and start: `scripts/windows/kame.ps1`.

## Rules that must not be weakened
- **Money is integer minor units (`bigint`).** Never use floats. Parse with `parseAmount` (strict; rejects rather than rounds).
- **The database enforces the ledger:**
  - Entries balance per currency.
  - Ledger, audit and decision tables are append-only.
  - Wallets never go negative.
  - Balances change only via ledger entries.
  - Every conversion is a two-currency `fx` txn that includes USDC.

  Don't bypass these; fix the caller.
- **Every outgoing movement goes through the gate.** Funds are checked before the gate; holds reserve funds in `compliance_hold`; sanctions hits are blocked plus get an OFAC report, never merely held.
- **Never tell customers why they were screened (no tipping off).** Use `customerFacingReasons`.
- **Fail closed:** unscreened address = deny; missing Travel Rule data = deny; production refuses mock providers.
- **Lock order:**
  1. User row (`FOR NO KEY UPDATE`).
  2. Wallets (`lockWallet`, by id for multi-wallet).
  3. System accounts, which `postLedgerTxn` locks by id.
- **Idempotency:** transfers (key + canonical body hash), deposits (network, tx_hash, log_index), FX (quote id), withdrawals (transfer_id to the custodian).
- **Policy numbers live only in `DEFAULT_POLICY`.** They are placeholders owned by compliance; bump `policyVersion` when they change.
- Every bug fix in money or compliance code gets a regression test.

## Branding
Name **Kame** (working name; trademark search pending). Gold `#FFC21A` is for surfaces only, with ink `#111111` text on it; never gold text on light backgrounds. The mark is `apps/mobile/src/components/KameMark.tsx`. Keep it original: no third-party franchise imagery or competitor look-alikes.

## Status
- **Built:** the review console (four-eyes), the withdrawal worker, and daily reconciliation and re-screening.
- **Mocked:** all partners (custody, KYC, screening, SMS, FX rates).
- **Not built yet** (see `docs/COMPLIANCE.md` §5): staff SSO/MFA, the real partner integrations, the Expo Router migration, and translating ledger descriptions to Spanish.
