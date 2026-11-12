import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTransfer, DEFAULT_POLICY, type Party, type TransferContext } from '../src/compliance.ts';

const ok: Party = { userId: 'a', status: 'active', kycTier: 1, screening: 'clear' };
const base: TransferContext = {
  kind: 'p2p',
  sender: ok,
  recipient: { ...ok, userId: 'b' },
  amountUsdCents: 50_00n,
  sentLast24hUsdCents: 0n,
  sentLast30dUsdCents: 0n,
};

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
  const t2 = { ...ok, kycTier: 2 as const };
  const d = evaluateTransfer({ ...base, sender: t2, recipient: t2, amountUsdCents: 3_000_00n });
  assert.deepEqual(d, { outcome: 'review', reasons: ['amount_requires_review'] });
});
