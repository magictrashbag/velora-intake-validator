# Compliance map

> **Not legal advice.** This is an engineering map of the obligations we expect, written so that counsel and a compliance officer can correct it. The sanctions picture for Venezuela changed several times in 2026, so verify everything against primary sources before relying on it.

## Operating model (recommended)

Puente is the **technology and customer layer**. Regulated activities are performed by **licensed partners** under their licenses:

| Activity | Who does it | Why |
|---|---|---|
| Holding customer USDC | Licensed custodian (omnibus, segregated) | We never hold private keys |
| USD money transmission (diaspora → VE) | Licensed MSB/MTL partner (US) / EMI (EU) | Avoids 49-state MTL licensing at launch |
| Bs payouts / Pago Móvil | Licensed Venezuelan partner | Local banking access |
| Identity verification | KYC vendor | Document + liveness checks |
| Sanctions & PEP screening | Screening vendor | OFAC SDN and other lists, ongoing monitoring |
| Card issuing | Issuer-processor + sponsor bank | PCI and network rules |

Partners will underwrite *us*. The controls below are what lets them say yes, and keep saying yes.

## United States

- **OFAC: Venezuela-related sanctions.** EO 13884 blocks the Government of Venezuela (GoV), including entities it owns or controls such as BCV, PdVSA and state banks. EO 13827 prohibits dealings in GoV-issued digital currency (e.g., the Petro). General Licenses relax parts of this regime and are amended often:
  - **GL 16C**: noncommercial personal remittances (including through named state banks), and accounts of US persons at certain state banks.
  - **GL 57** (April 2026): financial services involving **named** state banks (e.g., Banco de Venezuela, Banco del Tesoro; confirm the exact list in the official text).
  - **In code:** `DEFAULT_POLICY.govBankCodes` / `govBankOutcome` in `packages/core/src/compliance.ts`. The default is **review**; counsel sets it to `allow` or `deny` per product. Screening of every party is mandatory, and a confirmed match is a deny. Never process GoV-issued digital currency.
- **FinCEN / BSA:** MSB registration if we transmit or exchange in our own right. Partner-led, it means a written AML program, an appointed BSA officer, SAR/CTR processes, record keeping and the Travel Rule (≥US$3,000).
- **State money transmitter licenses:** avoided at launch through partner structure, which counsel must confirm.

## Venezuela

- **SUNACRIP** (crypto-asset regulator): under intervention/restructuring since 2023. Licensing has been sparse and is publicised by the companies rather than in an official list. We need either our own license or a licensed local partner, plus a plan for SUNACRIP changes.
- **SUDEBAN / BCV:** rules for bank payouts and the official exchange rate. Decide (with counsel) which rate source we quote against and how we disclose it.
- **SENIAT:** tax treatment, including the IGTF on foreign-currency/crypto payments. Sources disagree on how it applies to stablecoins.

## What's already enforced in code

| Control | Where |
|---|---|
| KYC tiers with per-txn / daily / 30-day limits; tier 0 cannot move money | `compliance.ts` `DEFAULT_POLICY.limits` |
| Sanctions screening status gates sender **and** recipient (confirmed → deny, potential/pending → review) | `compliance.ts` `checkParty` |
| GoV-bank counterparty control (configurable) | `compliance.ts` |
| Large-amount manual review threshold | `reviewAboveUsdCents` |
| No tipping off: screening reasons hidden from customers | `apps/api/src/movement.ts` `USER_SAFE` |
| Every gate decision stored with inputs + policy version | `compliance_decisions` table |
| Immutable audit trail and ledger | append-only triggers in `001_init.sql` |
| No double-spend on retry; no overdraft under concurrency | idempotency + row locks + DB CHECK, tested in `apps/api/test/api.test.ts` |
| Credentials never stored in plaintext; logs redact auth headers & OTPs | `auth.ts`, `app.ts` |

**Every number in `DEFAULT_POLICY` is a placeholder.** Limits, the review threshold and the bank list belong to the compliance officer, and changing them requires bumping `policyVersion` in `apps/api/src/config.ts`.

## Before launch (checklist)

- [ ] Counsel opinion: US sanctions (GL 16C / GL 57 scope for each product line), MSB/MTL structure, Venezuelan licensing
- [ ] Partner contracts: custody, KYC, screening, Bs payout, remittance corridor (two per critical rail)
- [ ] Written AML/KYC program, risk assessment, BSA officer, SAR process, record-retention policy
- [ ] Ongoing (not just onboarding) sanctions re-screening; list-update webhook re-screens all users
- [ ] Transaction monitoring rules (structuring, rapid in/out, mule patterns) feeding the review queue
- [ ] Manual review console with four-eyes approval for releasing held transfers
- [ ] Geo/IP and phone-country controls for other comprehensively sanctioned jurisdictions
- [ ] Customer terms, privacy policy (Spanish), complaint handling, published review SLAs
- [ ] Daily reconciliation: `custody_float` vs custodian, `payout_clearing` vs Bs partner
- [ ] Security: pen test, threat model, secrets in KMS, DB role separation, incident response plan, bug bounty
- [ ] SOC 2 Type I readiness (partners will ask)

## Sources

- OFAC recent actions: https://ofac.treasury.gov/recent-actions/20260202 · https://ofac.treasury.gov/recent-actions/20261016
- GL 56/57 analyses: https://www.crowellfintalk.com/2026/04/ofac-expands-venezuela-sanctions-relief-new-general-licenses-56-and-57-and-guidance-on-reporting-obligations/ · https://sanctionsnews.bakermckenzie.com/ofac-issues-new-venezuela-related-general-licenses-authorizing-commercial-negotiations-of-contingent-contracts-with-gov-and-financial-services-involving-named-venezuelan-banks/ · https://www.thompsonhinesmartrade.com/2026/04/ofac-issues-general-licenses-authorizing-venezuelan-certain-commercial-and-banking-transactions/
- Venezuela crypto regulation status: https://www.lightspark.com/knowledge/is-crypto-legal-in-venezuela · https://coinstats.app/news/1aa71976ffaa368fe62b58633f701732fbf3459546c539dfae31e991690c1c88_Qu-exchanges-tienen-licencia-de-la-Sunacrip-en-2026-Lo-que-se-sabe-y-cmo-verificarlo/
