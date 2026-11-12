# Puente

**A dollar wallet, remittances, Bs ↔ USD exchange and payments for Venezuela**, built compliance-first.

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

In development the OTP code is returned in the `/v1/auth/otp/start` response. `POST /v1/dev/deposit` and `POST /v1/dev/kyc` simulate partner webhooks, so a user can be funded and verified. Those routes don't exist when `NODE_ENV=production`.

## Test

```bash
eval "$(scripts/test-db.sh start)"   # throwaway Postgres on :54329
npm run typecheck && npm test
```

The API tests run against real Postgres and check the properties that matter for a money app: retries never double-send, concurrent spends never overdraw, A→B / B→A transfers never deadlock, sanctions hits are blocked without telling the customer why, limits include prior volume, FX quotes execute once and expire, and the database rejects unbalanced, edited or deleted ledger rows on its own.

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

Amounts are decimal **strings**, never JSON numbers.
