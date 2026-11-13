# Kame

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

## Run it locally

You need **Node.js 22.9+**, **Git** and **Docker Desktop** (for Postgres). To try the app on a phone you also need **Expo Go**, with the phone on the same Wi-Fi as the PC.

### Windows (PowerShell)

**Easiest:** with Docker Desktop installed, download [`scripts/windows/kame.ps1`](scripts/windows/kame.ps1) and run it from the folder you saved it in:

```powershell
powershell -ExecutionPolicy Bypass -File .\kame.ps1
```

It installs Node.js and Git with `winget` if needed, puts Kame in `%USERPROFILE%\kame`, sets up the database and demo data, and opens the API, the app and the review console. Run it again any time to restart.

**Or step by step:**

```powershell
git clone https://github.com/magictrashbag/velora-intake-validator.git kame
cd kame
git checkout claude/kontigo-repo-repurpose-vl2exb
npm install

copy .env.example .env                               # API settings (works as-is with Docker)
copy apps\mobile\.env.example apps\mobile\.env       # where the app finds the API

npm run db:up          # starts Postgres in Docker (Docker Desktop must be running)
npm run db:migrate     # creates the tables
npm run seed           # demo customers + staff logins; prints them
npm run dev:api        # API + review console on http://localhost:3000  (leave this window open)
```

Then, in a **second** PowerShell window in the same folder:

- **App in your browser:** `npm run dev:web`, then press `w` if it doesn't open by itself.
- **App on your phone:**
  1. Run `ipconfig` and note the Wi-Fi adapter's **IPv4 Address** (e.g. `192.168.1.50`).
  2. Set `EXPO_PUBLIC_API_URL=http://192.168.1.50:3000` in `apps\mobile\.env`.
  3. Run `npm run dev:mobile` and scan the QR code with Expo Go (Android) or the Camera app (iPhone).
  4. If Windows Firewall asks about Node.js, allow it on **Private networks**.
- **Review console:** open http://localhost:3000/staff and paste a token printed by `npm run seed`. Approvals need two different staff, so use reviewer 1, then reviewer 2.

Log in with a demo phone (e.g. `+584121234567`). In development the 6-digit code is shown on screen. Run `npm run seed` again any time for fresh staff tokens; tokens last 12 hours. Stop the database with `npm run db:down`.

### macOS / Linux

The same steps, using `cp` instead of `copy` and `/` instead of `\`. Without Docker on Linux, `eval "$(scripts/test-db.sh start)"` starts a throwaway Postgres; put the printed URL in `.env`.

### Development-only behaviour

- The OTP code is returned by `/v1/auth/otp/start`.
- `POST /v1/dev/kyc` (tier, screening, legal name) and `POST /v1/dev/deposit` simulate partners. The deposit goes through the real screening path, and test addresses ending in `dead` or `beef` screen as sanctioned or high-risk.
- The browser preview may call the API from `localhost` (CORS).

None of this exists when `NODE_ENV=production`.

## Test

```bash
npm run typecheck
npm test            # uses DATABASE_URL from .env (Docker Postgres); each test file creates and drops its own database
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
| GET | `/v1/me` | profile, verification tier & limits, QR payment payload |
| GET | `/v1/recipients/lookup?phone=` | masked name ("Luis M.") to confirm the payee before sending; 30/hour |
| POST | `/v1/transfers` | `Idempotency-Key` header required; `{to_phone, amount, currency:"USDC"}` → 201 posted / 202 held / 403 denied |
| POST | `/v1/fx/quotes` | `{sell, buy, amount}` → firm quote, 30s |
| POST | `/v1/fx/quotes/:id/execute` | executes at most once |
| POST | `/v1/crypto/withdrawals` | `Idempotency-Key`; `{network, address, amount, travel_rule?}`; address screened; Travel Rule ≥ US$1,000 |
| POST | `/v1/webhooks/custody/deposits` | custodian only; HMAC `x-signature` over `x-timestamp.body` |
| POST | `/v1/webhooks/custody/withdrawals` | custodian only; `confirmed` settles, `failed` refunds |

Amounts are decimal **strings**, never JSON numbers.

**Staff review console**: open `http://localhost:3000/staff` and sign in with a staff token. The API underneath uses separate tokens issued by `DATABASE_URL=... npm run staff -w @kame/api -- create <email> <reviewer|compliance_officer|admin>`:

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/staff/cases` | open + awaiting-second-approval cases, with internal reasons |
| GET | `/v1/staff/cases/:id` | subject, every compliance decision, every staff action |
| POST | `/v1/staff/cases/:id/{approve,reject,block,comment}` | `{note}` required; approve is four-eyes; unfreeze needs compliance officers |
| POST | `/v1/staff/sanctions/addresses` | compliance officers; newly sanctioned addresses → denylist, halt withdrawals, open cases |
