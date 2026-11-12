# Puente — Product Spec (v0.1)

> "Puente" is a working name. Check trademarks in Venezuela, the US and Colombia before using it publicly.

## 1. Problem

Venezuelans earn, save and spend in a mix of bolívares and dollars. The bolívar keeps losing value, cash dollars are hard to use, and the diaspora (roughly 8M people) sends money home through informal channels. Stablecoins, mostly USDT, have become the de facto savings and FX rail: more than US$70B of off-exchange USDT volume in 2025, as reported by TRM Labs and others. Yet everyday users still depend on Telegram P2P desks and on apps whose banking and payment partners can disappear overnight.

## 2. What the incumbents teach us

Public reporting on the market leader, Kontigo, during 2026 is the clearest lesson. Everything below is as reported by others and has not been independently verified (see sources):

| Reported event | What we do differently |
|---|---|
| Security incident (Jan 2026) where some users' funds were compromised; later reimbursed | DB-enforced ledger invariants, keys never held by us (licensed custody), security review before launch, bug bounty |
| US payment/banking partners (Stripe, Bridge, PayPal, a US bank) withdrew; US accounts for Venezuelans suspended (Mar 2026) | Compliance-first from day 1 so partners can underwrite us; **≥2 partners per critical rail** (custody, on-ramp, payout) behind the adapter interfaces in `packages/core/src/providers.ts` |
| Press allegations of sanctions-evasion exposure | Sanctions screening on every party, Gov-of-Venezuela counterparty controls, an immutable decision log that shows *why* every transfer was allowed |
| User reports of blocked withdrawals | Transparent status for every transfer (`posted` / `held_for_review` / `denied`), published review SLAs, safeguarded customer funds held 1:1 |

Positioning: **the trustworthy one.** Users have just watched an app they relied on wobble. Our edge is that this one doesn't.

## 3. Users

1. **Saver in Venezuela.** Paid in Bs, wants to hold dollars safely, and needs Bs again for rent and groceries. Uses Pago Móvil every day.
2. **Diaspora sender** (US, Spain, Colombia, Chile, Peru). Sends US$100–500 per month to family and wants it cheap, fast and traceable.
3. **Small merchant.** Wants to accept dollars without cash risk and get paid out in Bs or USD.

## 4. Product lines (all four in scope; phased)

| # | Line | MVP behaviour | Rails / partners |
|---|---|---|---|
| A | **USD wallet** | Balance held as USDC (shown as "dólares"); free instant P2P by phone number | Licensed custodian (omnibus) |
| B | **Bs ↔ USD exchange** | Firm quote valid for 30s, spread shown up front, executes once | FX inventory + licensed local Bs partner (Pago Móvil) |
| C | **Remittances in** | Sender abroad pays by card/ACH/SEPA; recipient gets USD in wallet or Bs via Pago Móvil | Licensed MTL/EMI partner per corridor |
| D | **Payments / card** | Merchant QR pay (P2P under the hood), then a virtual USD card | Card issuer-processor (we never see PANs) |

## 5. Phases

- **Phase 0, this repo now:** ledger, compliance gate, auth, wallet, P2P, Bs↔USD quote/execute, mobile login and wallet screen. Partners mocked.
- **Phase 1, closed beta (≈200 users):** real custody plus KYC partner, USDC deposit/withdraw, Bs payout via one local partner, manual review console, monitoring.
- **Phase 2:** first remittance corridor (US→VE), a second partner per rail, merchant QR.
- **Phase 3:** virtual card, savings/yield (only if it can be offered legally), more corridors.

## 6. Non-goals (for now)

Lending, self-custody wallets, tokens of our own, Petro or any Gov-of-Venezuela–issued digital currency (prohibited for US persons under EO 13827), and accepting users in other comprehensively sanctioned jurisdictions.

## 7. Success metrics

Weekly active savers · Bs↔USD volume and realised spread · Remittance cost vs. the informal market · Median time from review to decision · **Zero** ledger invariant violations · Partner count per rail (≥2).

## Sources

- Kontigo security incident & reimbursements: https://finanzasdigital.com/kontigo-falla-seguridad-reembolsos-enero-2026/
- US account suspension: https://www.dlnews.com/articles/markets/crypto-exchange-kontigo-suspends-us-accounts-for-venezuelans/ · https://www.criptonoticias.com/mercados/kontigo-suspende-cuentas-estadounidenses-clientes-venezolano/
- WSJ coverage: https://www.itiger.com/news/2608836943
- Stablecoin use in Venezuela: https://finance.yahoo.com/news/stablecoin-venezuela-set-rise-bol-070534598.html · https://cryptovalleyjournal.com/focus/background/venezuela-dollar-shortage-pushes-businesses-into-the-crypto-market/
