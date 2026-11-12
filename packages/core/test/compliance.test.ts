import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTransfer, DEFAULT_POLICY, requiresOfacReport, isNearThreshold, customerFacingReasons,
  type Party, type TransferContext,
} from '../src/compliance.ts';

const ok: Party = { userId: 'a', status: 'active', kycTier: 1, screening: 'clear', country: 'VE', accountAgeDays: 90 };
const t2: Party = { ...ok, kycTier: 2 };
const base: TransferContext = {
  kind: 'p2p',
  sender: ok,
  recipient: { ...ok, userId: 'b' },
  amountUsdCents: 50_00n,
  sentLast24hUsdCents: 0n,
  sentLast30dUsdCents: 0n,
  recentNearThresholdCount: 0,
};
const withdrawal: TransferContext = {
  ...base, kind: 'crypto_withdrawal', sender: t2, recipient: undefined,
  counterpartyAddress: { network: 'polygon', address: '0xabc', risk: 'clear' },
};
const travel = { originatorName: 'Ana Pérez', beneficiaryName: 'Ana Pérez', beneficiaryWalletType: 'self_hosted' as const };

test('clean small P2P is allowed', () => {
  assert.deepEqual(evaluateTransfer(base), { outcome: 'allow', reasons: [] });
});

test('tier 0 cannot move money', () => {
  const d = evaluateTransfer({ ...base, sender: { ...ok, kycTier: 0 } });
  assert.equal(d.outcome, 'deny');
  assert.ok(d.reasons.includes('kyc_tier_insufficient'));
});

test('rolling limits include the new amount', () => {
  assert.equal(evaluateTransfer({ ...base, sentLast24hUsdCents: 450_00n }).outcome, 'allow');
  const d = evaluateTransfer({ ...base, sentLast24hUsdCents: 450_01n });
  assert.deepEqual(d, { outcome: 'deny', reasons: ['limit_daily'] });
  assert.ok(evaluateTransfer({ ...base, sentLast30dUsdCents: 1_990_00n }).reasons.includes('limit_monthly'));
});

test('sanctions: confirmed match denies, potential match routes to review', () => {
  assert.equal(evaluateTransfer({ ...base, recipient: { ...ok, screening: 'confirmed_match' } }).outcome, 'deny');
  const d = evaluateTransfer({ ...base, recipient: { ...ok, screening: 'potential_match' } });
  assert.deepEqual(d, { outcome: 'review', reasons: ['recipient_screening_potential_match'] });
});

test('frozen accounts cannot send or receive', () => {
  assert.equal(evaluateTransfer({ ...base, sender: { ...ok, status: 'frozen' } }).outcome, 'deny');
  assert.equal(evaluateTransfer({ ...base, recipient: { ...ok, status: 'frozen' } }).outcome, 'deny');
});

test('embargoed jurisdictions: both sides blocked and reportable; sender told only "not supported"', () => {
  const s = evaluateTransfer({ ...base, sender: { ...ok, country: 'IR' } });
  assert.deepEqual(s.reasons, ['sender_jurisdiction_blocked']);
  assert.ok(requiresOfacReport(s.reasons));
  assert.deepEqual(customerFacingReasons(s.reasons), ['jurisdiction_not_supported']);
  const d = evaluateTransfer({ ...base, recipient: { ...ok, country: 'KP' } });
  assert.deepEqual(d.reasons, ['recipient_jurisdiction_blocked']);
  assert.ok(requiresOfacReport(d.reasons));
});

test('payouts to state-owned banks go to review by default (OFAC GLs), deny if counsel says so', () => {
  const payout = { ...base, kind: 'payout_bank' as const, recipient: undefined };
  const d = evaluateTransfer({ ...payout, recipientBankCode: '0102' });
  assert.deepEqual(d, { outcome: 'review', reasons: ['gov_bank_counterparty:0102'] });
  const strict = { ...DEFAULT_POLICY, govBankOutcome: 'deny' as const };
  assert.equal(evaluateTransfer({ ...payout, recipientBankCode: '0102' }, strict).outcome, 'deny');
  const relaxed = { ...DEFAULT_POLICY, govBankOutcome: 'allow' as const };
  assert.equal(evaluateTransfer({ ...payout, recipientBankCode: '0102' }, relaxed).outcome, 'allow');
  assert.equal(evaluateTransfer({ ...payout, recipientBankCode: '0105' }).outcome, 'allow');
  assert.equal(evaluateTransfer({ ...payout, recipientBankCode: 'xx' }).outcome, 'deny');
});

test('large amounts are queued for manual review, not silently allowed', () => {
  const d = evaluateTransfer({ ...base, sender: t2, recipient: t2, amountUsdCents: 3_000_00n });
  assert.deepEqual(d, { outcome: 'review', reasons: ['amount_requires_review'] });
});

test('crypto: address screening fails closed', () => {
  assert.deepEqual(evaluateTransfer({ ...withdrawal, counterpartyAddress: undefined }).reasons, ['address_missing']);
  const un = evaluateTransfer({ ...withdrawal, counterpartyAddress: { network: 'polygon', address: '0x', risk: 'unscreened' } });
  assert.deepEqual(un, { outcome: 'deny', reasons: ['address_unscreened'] });
  const sanc = evaluateTransfer({ ...withdrawal, counterpartyAddress: { network: 'polygon', address: '0x', risk: 'sanctioned' } });
  assert.deepEqual(sanc, { outcome: 'deny', reasons: ['address_sanctioned'] });
  assert.ok(requiresOfacReport(sanc.reasons));
  const hr = evaluateTransfer({ ...withdrawal, counterpartyAddress: { network: 'polygon', address: '0x', risk: 'high_risk' } });
  assert.deepEqual(hr, { outcome: 'review', reasons: ['address_high_risk'] });
  const net = evaluateTransfer({ ...withdrawal, counterpartyAddress: { network: 'tron', address: 'T', risk: 'clear' } });
  assert.deepEqual(net.reasons, ['network_not_supported']);
});

test('crypto deposits from sanctioned addresses are denied even for tier 0 (no limit check on inbound)', () => {
  const dep: TransferContext = { ...withdrawal, kind: 'crypto_deposit', sender: { ...ok, kycTier: 0 } };
  assert.equal(evaluateTransfer(dep).outcome, 'allow');
  assert.equal(evaluateTransfer({ ...dep, counterpartyAddress: { network: 'base', address: '0x', risk: 'sanctioned' } }).outcome, 'deny');
});

test('Travel Rule: info required at/above US$1,000 (FATF), not below', () => {
  assert.equal(evaluateTransfer({ ...withdrawal, amountUsdCents: 999_99n }).outcome, 'allow');
  assert.deepEqual(evaluateTransfer({ ...withdrawal, amountUsdCents: 1_000_00n }).reasons, ['travel_rule_info_required']);
  assert.equal(evaluateTransfer({ ...withdrawal, amountUsdCents: 1_000_00n, travelRule: travel }).outcome, 'allow');
  const vaspNoName = { ...travel, beneficiaryWalletType: 'vasp' as const };
  assert.equal(evaluateTransfer({ ...withdrawal, amountUsdCents: 1_000_00n, travelRule: vaspNoName }).outcome, 'deny');
  const blank = { ...travel, beneficiaryName: '  ' };
  assert.equal(evaluateTransfer({ ...withdrawal, amountUsdCents: 1_000_00n, travelRule: blank }).outcome, 'deny');
});

test('monitoring: new account high value and structuring go to review', () => {
  const fresh = evaluateTransfer({ ...base, sender: { ...ok, accountAgeDays: 1 }, amountUsdCents: 300_00n });
  assert.deepEqual(fresh, { outcome: 'review', reasons: ['new_account_high_value'] });
  // Three transfers in a day each just under the US$1,000 Travel Rule threshold.
  const s = evaluateTransfer({ ...withdrawal, amountUsdCents: 950_00n, recentNearThresholdCount: 2 });
  assert.deepEqual(s, { outcome: 'review', reasons: ['possible_structuring'] });
  assert.equal(evaluateTransfer({ ...withdrawal, amountUsdCents: 950_00n, recentNearThresholdCount: 1 }).outcome, 'allow');
  assert.ok(isNearThreshold(900_00n, 1_000_00n));
  assert.ok(!isNearThreshold(899_99n, 1_000_00n));
  assert.ok(!isNearThreshold(1_000_00n, 1_000_00n));
});

test('customer-facing reasons never leak internal codes, even alongside safe ones', () => {
  assert.deepEqual(customerFacingReasons(['limit_daily']), ['limit_daily']);
  assert.deepEqual(customerFacingReasons(['limit_daily', 'recipient_sanctions_match']), ['not_permitted']);
  assert.deepEqual(customerFacingReasons([]), ['not_permitted']);
});
