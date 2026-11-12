# Compliance

> **Not legal advice.** This is an engineering map of the obligations we expect, written so that counsel and a compliance officer can correct it. It was researched in November 2026, mostly from law-firm and vendor summaries of primary sources. The Venezuela sanctions regime was amended several times in 2026. **Verify every item against the primary source before launch.**
>
> **No compliance program is "bulletproof."** The goal is *defensible*: when a regulator, a bank partner or an auditor asks "why did you allow this?", we can show the rule, the inputs, the decision and who approved it. The code is built to make that answer automatic.

## 1. The crypto-routing decision, stated precisely

**Product rule:** every currency conversion settles through **USDC**. USD→VES is executed as USD→USDC, then USDC→VES. There is never a direct fiat↔fiat leg.

**What this does NOT do:** it doesn't reduce our regulatory obligations. Our research found no rule requiring conversions to go through crypto. Under FinCEN guidance (2013; FIN-2019-G001, still in force), a business that buys or sells convertible virtual currency, including stablecoins, is a **money transmitter**. Routing through crypto keeps every fiat-side obligation and adds crypto-specific ones (§3).

**Why we do it anyway:**
- Venezuela's dollar market already runs on stablecoins. Liquidity and customer trust are there.
- One settlement asset means one reconciliation point (USDC custody vs. ledger).
- The BCV official rate and the USDT P2P rate diverged by **14–22%** through Aug–Sep 2026 (per market trackers). Pricing everything against one auditable USDC leg makes the rate we used, and its source, explicit on every trade.

**How it's enforced**, in three independent layers:

| Layer | Mechanism |
|---|---|
| Domain | `planConversion()` in `packages/core/src/routing.ts` always emits X→USDC→Y legs |
| Database (ledger) | Deferred constraint trigger `ledger_entries_routed`, which runs at COMMIT even for hand-written SQL:<br>• Only `fx` transactions may change currency, and each must be exactly two currencies, one of them USDC.<br>• Only `fx` transactions may touch the FX inventory.<br>• Every other transaction must be single-currency.<br>So a conversion can't be smuggled through as two separate single-currency postings either. |
| Database (quotes) | `fx_quotes_routed` CHECK: every quote has USDC on one side |

**Which stablecoin:** USDC, not USDT, even though USDT dominates Venezuelan P2P.
- Under the **GENIUS Act** (effective 18 Jan 2027), Treasury's August 2026 proposal would allow US digital-asset service providers to offer only *permitted* payment stablecoins from **18 Jul 2028**.
- USDT remains offshore. Tether's GENIUS-compliant US token is a separate product (USAT).
- Accepting inbound USDT (auto-converted at deposit) is a Phase 2 decision for counsel. `SETTLEMENT_ASSET` is a single constant if it ever has to change.

## 2. Operating model

Puente is the **technology and customer layer**. Regulated activities are performed by **licensed partners** under their licenses (partner interfaces: `packages/core/src/providers.ts`):

| Activity | Who | Note |
|---|---|---|
| Holding customer USDC | Licensed custodian (omnibus, segregated) | We never hold private keys |
| USD money transmission (diaspora → VE) | Licensed MSB/MTL (US) / EMI (EU) partner | Avoids 49-state MTL licensing at launch; counsel to confirm we are an agent, not a transmitter |
| Bs payouts / Pago Móvil | Licensed Venezuelan partner | |
| Identity verification | KYC vendor | Only references stored by us |
| Party + address screening | OFAC/PEP screening + blockchain-analytics vendor | |
| Card issuing | Issuer-processor + sponsor bank | PCI scope stays with them |

**Partner concentration is the #1 business risk.** In 2026 the market leader reportedly lost Stripe/Bridge, PayPal and its US banking provider within weeks. Plan for at least two partners per critical rail; the adapter interfaces exist so a partner can be swapped without touching the ledger.

## 3. Obligations map → where it's handled

### United States

| Obligation | Source | Status in code |
|---|---|---|
| **Venezuela sanctions** (GoV blocked; GoV digital currency prohibited) | EO 13884, EO 13827; all Venezuela sanctions remain in effect per OFAC FAQs | Gov-bank counterparty rule (`govBankCodes`, default **review**). Party screening on sender **and** recipient |
| **General Licenses** relaxing the above | GL 16C (personal remittances; accounts at named state banks), **GL 57** (Apr 2026: financial services with *named* state banks; bank list differs between summaries, so read the official text) | Default `govBankOutcome: 'review'`; counsel decides allow/deny per product |
| **Comprehensive embargoes** | Cuba, Iran, North Korea, Crimea/"DNR"/"LNR" regions. Syria's program was revoked by EO 14312 (Jun 2025); listed Syrian persons remain blocked | Sign-up refused by phone prefix; residence-country rule in gate. **To add:** IP geolocation + KYC address (OFAC VC guidance) |
| **Address screening** | OFAC SDN lists crypto addresses, exact match only (FAQ 594), and says the list is not exhaustive (FAQ 562) | Every withdrawal **and** deposit address is screened; **fail-closed** (unscreened = deny); evidence kept in `address_screenings` (append-only); `high_risk` → review |
| **Blocking & reporting** | Blocked property report and rejected transaction report, **within 10 business days** (31 CFR 501.603 / 501.604); annual blocked-property report by 30 Sep | Sanctioned deposit → `blocked_funds` account (never credited) + `ofac_reports` row with `due_by`; rejected sanctioned withdrawal → `rejected_transaction` report. **To add:** daily alert on reports nearing `due_by` |
| **BSA / AML program** | FinCEN MSB rules for CVC (registration, AML program, SAR/CTR, records) | Placeholder limits, review queue, decision log. **To add:** SAR workflow, BSA officer, written program |
| **Travel Rule** | US: US$3,000 (31 CFR 1010.410(f)); FATF R.16: USD/EUR 1,000 (2025 revision; jurisdictions must adopt by end-2030) | **US$1,000 applied (stricter of the two)**. Originator name comes only from the KYC record, never from request input. Stored in `travel_rule_records` (append-only). **To add:** VASP-to-VASP messaging protocol |
| **Stablecoin eligibility** | GENIUS Act; OCC final rule Oct 2026; Treasury DASP proposal Aug 2026 | USDC only; network allowlist |

FinCEN withdrew several proposed digital-asset rules on 5 Oct 2026, and an April 2026 NPRM covers stablecoin issuers. Track both; neither changes the MSB baseline above.

### Venezuela

| Item | Status |
|---|---|
| **FATF grey list.** Venezuela has been listed since June 2024 and remained on it after the Oct 2026 plenary | Partners must apply **enhanced due diligence** to us and our customers. Built in: low tier-1 limits, mandatory screening, new-account and structuring rules. Expect partners to ask for source-of-funds at tier 2 |
| **SUNACRIP** (crypto regulator): under intervention since the March 2023 scandal; licences issued sparsely (reportedly Kontigo until Jan 2027, Crixto until Dec 2026) and publicised by the companies rather than in an official list | **Blocking for launch:** our own licence or a licensed local partner. Watch for regulator restructuring |
| **LOCDOFT / UNIF** (AML law, financial-intelligence unit; reporting reportedly paper-based) | Local SAR equivalent process needed |
| **SUDEBAN / BCV** (bank payouts, official rate) | Decide the **reference rate** with counsel: BCV official vs. market. Disclose the rate source and spread on every quote (we already store `mid_rate`, `rate_source`, `spread_bps` per quote) |
| **SENIAT** (tax; IGTF on foreign-currency/crypto payments, application to stablecoins disputed) | Open question for local tax counsel |

## 4. Controls enforced in code today

| # | Control | Where | Test |
|---|---|---|---|
| 1 | One gated path for all outgoing money | `apps/api/src/movement.ts` | api + crypto tests |
| 2 | KYC tiers & rolling limits (tier 0 cannot send) | `compliance.ts` `limits` | ✓ |
| 3 | Party sanctions screening, both sides (pending/potential → review, match → deny) | `checkParty` | ✓ |
| 4 | Embargoed jurisdictions (sign-up + gate) | `jurisdiction.ts` | ✓ |
| 5 | Address screening, fail-closed, evidence kept | `deposits.ts`, `routes/crypto.ts` | ✓ |
| 6 | Any sanctions nexus on a deposit (source address, the customer, embargoed residence) → **blocked**, never merely held, + OFAC report due | `deposits.ts` | ✓ |
| 7 | Deposits for not-yet-screened customers held | gate review → `compliance_hold` | ✓ |
| 8 | Travel Rule ≥ US$1,000; originator from KYC only | gate + `movement.ts` | ✓ |
| 9 | Structuring (3+ transfers just under a threshold in 24h) → review | `isNearThreshold` | ✓ |
| 10 | New account (<7d) moving ≥ US$300 → review | gate | ✓ |
| 11 | Large amount (≥ US$3,000, in or out) → review | gate | ✓ |
| 12 | No tipping off: if *any* reason is internal, the customer sees only `not_permitted` | `CUSTOMER_SAFE_REASONS` | ✓ |
| 13 | USDC-routing invariant (DB) | `002_crypto_compliance.sql` | ✓ |
| 14 | Double-entry, append-only, no overdraft (DB) | `001_init.sql` | ✓ |
| 15 | Idempotency: transfers (key + canonical body hash), deposits (network + normalised tx hash + log index; a mismatched replay is a 409, never dropped), FX (quote id) | ✓ | ✓ |
| 15a | Funds checked **before** the gate: an unfunded request can't be used to probe screening results, and files nothing | `movement.ts` | ✓ |
| 15b | Held transfers **reserve** their funds in `compliance_hold`, so approval can never find them gone | `movement.ts` | ✓ |
| 15c | 3 sanctions-related denials in 24h → account auto-frozen | `movement.ts` | ✓ |
| 15d | Limits/thresholds compare USD **rounded up**; amounts capped far inside bigint | `money.ts` | ✓ |
| 15e | Balances change **only** via ledger entries; account identity immutable; accounts undeletable (DB trigger) | `003_hardening.sql` | ✓ |
| 15f | Client IP from `X-Forwarded-For` only if the proxy is listed in `TRUST_PROXY` (audit evidence can't be spoofed) | `config.ts` | ✓ |
| 16 | Withdrawal outbox: debit and send-instruction commit atomically | `crypto_withdrawals` | ✓ |
| 17 | Webhooks: HMAC + 5-min replay window, authenticated before parsing the schema | `routes/crypto.ts` | ✓ |
| 18 | Production refuses to start with mock providers or missing secrets; dev routes absent | `app.ts`, `config.ts` | ✓ |
| 19 | Every decision stored with full inputs + policy version | `compliance_decisions` | ✓ |

An independent adversarial review of this code (Nov 2026) found 10 defects, including a sanctioned customer's deposit landing in a releasable hold, double-credit via tx-hash letter case, and probing screening results with an empty wallet. All 10 are fixed, each with a regression test.

**Every number in `DEFAULT_POLICY` is a placeholder** owned by the compliance officer. Changing one requires bumping `policyVersion` in `apps/api/src/config.ts`, so every past decision can be explained under the policy that produced it.

## 5. Not built yet (blocking for real money)

**Legal & program**
- [ ] Counsel opinions: US (GL 16C/57 scope per product line, MSB/agent structure, GENIUS Act DASP status) and Venezuela (SUNACRIP licence or partner, BCV rate, IGTF)
- [ ] Written BSA/AML program, risk assessment, BSA officer, SAR/CTR procedures, record retention (5 years minimum)
- [ ] Partner contracts: two per rail (custody, on-ramp, Bs payout, screening/analytics)

**Engineering**
- [x] **Review console API** (`/v1/staff/cases`):
  - Four-eyes approval for transfers, deposits and unfreezes.
  - At execution the gate re-runs on current facts, with fresh address screening. If it would now deny, or raise new review reasons, execution is refused and the refusal is recorded.
  - Reject (refund) or block (blocked property + OFAC report) needs one reviewer.
  - Append-only `review_actions`.
  - Held FX trades execute at the customer's original firm quote; the house carries the FX risk during review.
- [ ] Review console **UI**, and staff SSO + hardware-key MFA (staff tokens are currently issued by `npm run staff -w @puente/api`)
- [ ] Ongoing re-screening of all users and counterparties on list updates; retroactive address review when OFAC adds an address
- [ ] Daily OFAC-report deadline alerting; annual blocked-property report export
- [ ] Transaction monitoring beyond the gate: rapid in/out, fan-in/fan-out, mule networks, P2P cycling
- [ ] IP geolocation, VPN detection, device binding and step-up auth for sending
- [ ] Travel Rule VASP-to-VASP messaging; ownership proof for self-hosted wallets (e.g. message signing)
- [ ] Daily reconciliation: `custody_float` vs. custodian, `payout_clearing` vs. Bs partner, `blocked_funds` vs. OFAC filings
- [ ] Withdrawal worker (outbox → custodian) with confirmation tracking
- [ ] An app DB role without superuser/DDL rights (DB triggers can be bypassed by a superuser), plus a daily job that re-derives every balance from ledger entries
- [ ] Security: threat model, external pen test, secrets in KMS, DB role separation (app role cannot DDL), WAF/rate limits, incident response plan, bug bounty, SOC 2 readiness

## Sources

- OFAC: [recent actions 2026-02-02](https://ofac.treasury.gov/recent-actions/20260202) · [recent actions 2026-10-16](https://ofac.treasury.gov/recent-actions/20261016) · [VC compliance guidance](https://ofac.treasury.gov/system/files/126/virtual_currency_guidance_brochure.pdf) · [FAQs](https://ofac.treasury.gov/faqs/all-faqs) · [reporting FAQ](https://ofac.treasury.gov/faqs/topic/1606) · [31 CFR 501.603](https://www.law.cornell.edu/cfr/text/31/501.603)
- GL 56/57 analyses: [Crowell](https://www.crowellfintalk.com/2026/04/ofac-expands-venezuela-sanctions-relief-new-general-licenses-56-and-57-and-guidance-on-reporting-obligations/) · [Baker McKenzie](https://sanctionsnews.bakermckenzie.com/ofac-issues-new-venezuela-related-general-licenses-authorizing-commercial-negotiations-of-contingent-contracts-with-gov-and-financial-services-involving-named-venezuelan-banks/) · [Thompson Hine](https://www.thompsonhinesmartrade.com/2026/04/ofac-issues-general-licenses-authorizing-venezuelan-certain-commercial-and-banking-transactions/)
- Embargoes / Syria: [CASRAI](https://casrai.org/guides/embargoed-countries-list-export-control) · [sanctionslawyers.net](https://sanctionslawyers.net/blog-en/ofac-sanctioned-countries-list-2026/)
- FinCEN: [2013 guidance](https://www.fincen.gov/resources/statutes-regulations/guidance/application-fincens-regulations-persons-administering) · [withdrawal of proposed rules](https://www.fincen.gov/news/news-releases/fincen-announces-withdrawals-proposed-digital-asset-related-rules) · [2026 NPRM](https://www.fincen.gov/system/files/2026-04/PPSI-AMLCFT-NPRM.pdf)
- FATF R.16: [Mayer Brown](https://www.mayerbrown.com/en/insights/publications/2025/08/fatf-revises-aml-standards-for-certain-funds-transfers) · [21 Analytics](https://www.21analytics.ch/blog/fatf-recommendation-16-updated)
- GENIUS Act: [Goodwin (OCC final rule)](https://www.goodwinlaw.com/en/insights/publications/2026/11/alerts-technology-dcb-occ-issues-final-genius-act-implementing-rule) · [Jones Day (Treasury DASP proposal)](https://www.jonesday.com/en/insights/2026/08/us-treasury-proposes-genius-act-rules-for-stablecoin-issuance-offer-and-sale) · [CoinDesk on USDT](https://www.coindesk.com/news-analysis/2026/07/17/tether-s-usdt-hits-2-year-countdown-threatening-its-position-on-u-s-crypto-platforms)
- Venezuela: [FATF grey list Oct 2026](https://amluae.com/fatf-grey-list-update-october-2026/) · [KnowYourCountry](https://www.knowyourcountry.com/country-aml-intelligence/country/venezuela/) · [Lightspark](https://www.lightspark.com/knowledge/is-crypto-legal-in-venezuela) · [SUNACRIP licences (CoinStats)](https://coinstats.app/news/1aa71976ffaa368fe62b58633f701732fbf3459546c539dfae31e991690c1c88_Qu-exchanges-tienen-licencia-de-la-Sunacrip-en-2026-Lo-que-se-sabe-y-cmo-verificarlo/) · [BCV vs USDT gap (PitbullChain)](https://pitbullchain.com/noticias/brecha-entre-el-bcv-y-el-usdt-p2p-alcanza-el-21-8-analisis-de-mercado)
