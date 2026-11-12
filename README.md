# Puente

**A dollar wallet, remittances, Bs ↔ USD exchange and payments for Venezuela**, built compliance-first. Every conversion settles through USDC, and the database enforces this.

> Working name. Status: **Phase 0 scaffold.** The core money engine is real and tested. Licensed partners (custody, KYC, sanctions screening, Bs payouts, cards) are mocked behind interfaces. Not for real money yet: see [docs/COMPLIANCE.md](docs/COMPLIANCE.md).

| Doc | What's in it |
|---|---|
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) | Users, the four product lines, phases, lessons from incumbents |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack rationale, money-movement path, ledger design, security |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md) | OFAC/FinCEN/Venezuela map, controls already in code, launch checklist |

## Layout

```
packages/core   Pure TS domain: money (bigint minor units), FX (exact rationals), compliance gate, partner interfaces
apps/api        Fastify API: OTP auth, wallet, P2P transfers, Bs↔USD quotes, dev-only simulators
apps/mobile     Expo app (Spanish UI): phone login, balances, send dollars
db/migrations   Postgres schema; the DB itself enforces double-entry, append-only and no-overdraft
```

## Run it

Requires Node 22+ and Postgres 16 (Docker, or the bundled script).

```bash
npm install
docker compose up -d                      # or: eval "$(scripts/test-db.sh start)"
cp .env.example .env && export $(grep -v '^#' .env | xargs)
npm run db:migrate
npm run dev:api                           # http://localhost:3000
npm run dev:mobile                        # Expo; set EXPO_PUBLIC_API_URL to your machine's LAN IP for a phone
```

In development the OTP code is returned in the `/v1/auth/otp/start` response. `POST /v1/dev/kyc` (tier, screening, legal name) and `POST /v1/dev/deposit` simulate partners; the deposit goes through the real screening path, and test addresses ending in `dead` or `beef` screen as sanctioned or high-risk. Those routes don't exist when `NODE_ENV=production`.

## Test

```bash
eval "$(scripts/test-db.sh start)"   # throwaway Postgres on :54329
npm run typecheck && npm test
```

The API tests run against real Postgres and check the properties that matter for a money app:

- Retries never double-send, concurrent spends never overdraw, and A→B / B→A transfers never deadlock.
- Sanctions hits are blocked without telling the customer why.
- The database refuses fiat↔fiat conversions and unbalanced, edited or deleted ledger rows on its own.
- Deposits from sanctioned addresses are blocked and generate an OFAC report.
- The Travel Rule applies from US$1,000, and structuring patterns are held for review.
- Webhooks reject forged or replayed calls.

**Production** refuses to start without real SMS, FX-rate and screening providers and their secrets. None are integrated yet: that is Phase 1, gated on [docs/COMPLIANCE.md §5](docs/COMPLIANCE.md#5-not-built-yet-blocking-for-real-money).

## API (v1)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/otp/start` | `{phone}` (E.164) |
| POST | `/v1/auth/otp/verify` | `{phone, code}` → `{token}` |
| POST | `/v1/auth/logout` | |
| GET | `/v1/wallet` | balances + recent activity |
| POST | `/v1/transfers` | `Idempotency-Key` header required; `{to_phone, amount, currency:"USDC"}` → 201 posted / 202 held / 403 denied |
| POST | `/v1/fx/quotes` | `{sell, buy, amount}` → firm quote, 30s |
| POST | `/v1/fx/quotes/:id/execute` | executes at most once |
| POST | `/v1/crypto/withdrawals` | `Idempotency-Key`; `{network, address, amount, travel_rule?}`; address screened; Travel Rule ≥ US$1,000 |
| POST | `/v1/webhooks/custody/deposits` | custodian only; HMAC `x-signature` over `x-timestamp.body` |
| POST | `/v1/webhooks/custody/withdrawals` | custodian only; `confirmed` settles, `failed` refunds |

Amounts are decimal **strings**, never JSON numbers.

**Staff (review console)**, with separate tokens issued by `DATABASE_URL=... npm run staff -w @puente/api -- create <email> <reviewer|compliance_officer|admin>`:

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/staff/cases` | open + awaiting-second-approval cases, with internal reasons |
| GET | `/v1/staff/cases/:id` | subject, every compliance decision, every staff action |
| POST | `/v1/staff/cases/:id/{approve,reject,block,comment}` | `{note}` required; approve is four-eyes; unfreeze needs compliance officers |
