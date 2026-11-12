# Architecture

## Stack, and why it's "fintech compliant"

No framework is compliant on its own. Compliance comes from **what the system guarantees** and **which regulated activities it hands to licensed partners**. The stack was chosen to make those guarantees easy to enforce and to audit:

| Layer | Choice | Why |
|---|---|---|
| Mobile | Expo (React Native) + TypeScript | One codebase for Android (most of the market) and iOS; tokens kept in the OS keychain/keystore via `expo-secure-store` |
| API | Node 22 + Fastify 5 + TypeScript (strict) | JSON-schema validation on every route; small dependency surface |
| Database | PostgreSQL 16 | Transactions, row locks, CHECK constraints and triggers let the **database** enforce money invariants |
| Domain | `@puente/core` (pure TS, no I/O) | Money math and the compliance gate are pure functions: exhaustively testable, replayable for auditors |
| Hosting (planned) | A SOC 2 / PCI-attested cloud, managed Postgres with PITR, KMS-managed secrets, WAF | Inherit the controls auditors ask for |

## Components

```
 Expo app ──HTTPS──▶ Fastify API ──▶ Postgres (ledger, audit, decisions)
                       │
                       ├── @puente/core: money · fx · compliance gate
                       └── Partner adapters (packages/core/src/providers.ts)
                             KYC · Party + address screening · Custody (USDC) · Bs payout (Pago Móvil)
                             · FX rate source · Card issuer · SMS/WhatsApp OTP
```

## Money movement: one path for everything

Every transfer of any kind goes through `executeGatedMovement` (`apps/api/src/movement.ts`), in a single DB transaction:

1. Lock the sender row (`FOR NO KEY UPDATE`). This makes one sender's operations run one at a time, so idempotency checks and rolling limits are race-free.
2. **Idempotency:** the same `Idempotency-Key` with the same body replays the stored result. The same key with a different body is rejected.
3. Compute rolling 24h/30d volume, then run the **compliance gate**, which returns `allow`, `review` or `deny`.
4. If allowed, lock the wallets (in a fixed id order, so there are no deadlocks), check funds, and post balanced ledger legs.
5. Record the transfer, the full compliance decision (inputs + reasons + policy version) and an audit event.
6. Return a customer-safe result. Screening reasons are **never** shown to the customer, to avoid tipping off.

## Conversions route through USDC

`USDC` is the single settlement asset (`packages/core/src/routing.ts`). A conversion between two other currencies is two legs, X→USDC then USDC→Y, each its own balanced ledger transaction. The database rejects any ledger transaction touching more than two currencies, or two that don't include USDC (`ledger_entries_routed`, deferred to COMMIT). See [COMPLIANCE.md §1](COMPLIANCE.md#1-the-crypto-routing-decision-stated-precisely) for why, and for what this does *not* change legally.

## Crypto rails

- **Withdrawals** (`POST /v1/crypto/withdrawals`):
  1. Validate the address syntax, then screen it. Screening is a network call made before the DB transaction, and the evidence is stored.
  2. Run the gated movement (limits, Travel Rule, structuring).
  3. On allow, debit the wallet and credit `payout_clearing`, and insert an **outbox** row in the same transaction. A worker sends outbox rows to the custodian, using `transfer_id` as the idempotency key, so a crash can't lose or duplicate an on-chain send.
- **Deposits** (`POST /v1/webhooks/custody/deposits`):
  1. Verify the HMAC over `timestamp.rawBody` and the 5-minute window, before schema validation.
  2. Make processing idempotent on `(network, tx_hash)`, then screen the source address.
  3. The funds have already arrived on-chain, so we can't refuse them, only decide where they sit. Clean funds are credited to the user's wallet. Review cases go to `compliance_hold`. Sanctioned funds go to `blocked_funds`, and an OFAC blocked-property report becomes due within 10 business days.

## Ledger

Double-entry, signed integer minor units (`bigint`), in `db/migrations/001_init.sql`:

- `ledger_entries` per transaction must sum to zero per currency. This is checked by a **deferred constraint trigger at COMMIT**.
- `accounts.balance` is maintained by trigger. A `CHECK` prevents any user wallet going negative, even through a manual SQL query.
- `ledger_*`, `compliance_decisions` and `audit_log` are **append-only**: UPDATE, DELETE and TRUNCATE all raise. Corrections are new reversing transactions.
- System accounts (`custody_float`, `fx_inventory`, `payout_clearing`, `fee_revenue`, `compliance_hold`, `blocked_funds`) are the other side of every external flow. Reconciliation means comparing `custody_float` against the custodian's statement every day.

**Scaling note:** every FX execution updates the single `fx_inventory` row per currency. That is fine for beta. At scale, shard the system accounts (N sub-accounts chosen at random) or batch postings.

## Data handled

- Phone (E.164), KYC tier, screening status, account status. Identity documents stay with the KYC partner, and we store only its reference.
- Session tokens: random 256-bit; **stored only as SHA-256**; 12h TTL; revocable.
- OTP codes: HMAC-SHA256 with a server-side pepper; 5 min TTL; 5 attempts; 5 codes/hour per phone.
- Card PAN/CVV: never touch our systems (issuer-processor tokens only), which keeps PCI scope minimal.

## Production hardening still to do

See the "Before launch" checklist in [COMPLIANCE.md](COMPLIANCE.md). The engineering items are: a separate DB role without DDL rights, TLS everywhere, secrets in KMS, rate limiting at the edge, device binding and step-up auth for sending, certificate pinning in the app, a manual review console, partner webhooks with signature verification, daily reconciliation jobs, monitoring and alerting, an external penetration test, and a bug bounty.
