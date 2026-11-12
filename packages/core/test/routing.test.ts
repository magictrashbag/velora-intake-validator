import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planConversion, isRoutedLeg, SETTLEMENT_ASSET } from '../src/routing.ts';
import { isBlockedPhone, phoneCountry } from '../src/jurisdiction.ts';
import { isValidAddress, normalizeAddress, addBusinessDays } from '../src/crypto.ts';

test('every conversion routes through the crypto settlement asset', () => {
  assert.equal(SETTLEMENT_ASSET, 'USDC');
  assert.deepEqual(planConversion('USDC', 'VES'), [{ sell: 'USDC', buy: 'VES' }]);
  assert.deepEqual(planConversion('VES', 'USDC'), [{ sell: 'VES', buy: 'USDC' }]);
  assert.deepEqual(planConversion('USD', 'VES'), [{ sell: 'USD', buy: 'USDC' }, { sell: 'USDC', buy: 'VES' }]);
  assert.throws(() => planConversion('VES', 'VES'));
  for (const legs of [planConversion('USD', 'VES'), planConversion('VES', 'USD')]) {
    for (const l of legs) assert.ok(isRoutedLeg([l.sell, l.buy]));
  }
});

test('ledger leg validity', () => {
  assert.ok(isRoutedLeg(['USDC']));
  assert.ok(isRoutedLeg(['USDC', 'VES']));
  assert.ok(!isRoutedLeg(['USD', 'VES']), 'fiat<->fiat is never a valid leg');
  assert.ok(!isRoutedLeg(['USD', 'USDC', 'VES']), 'multi-hop must be separate legs');
});

test('jurisdiction filters', () => {
  for (const p of ['+5351234567', '+989121234567', '+8502123456', '+79781234567']) assert.ok(isBlockedPhone(p), p);
  for (const p of ['+584121234567', '+13055551234', '+79161234567']) assert.ok(!isBlockedPhone(p), p);
  assert.equal(phoneCountry('+584121234567'), 'VE');
  assert.equal(phoneCountry('+593991234567'), 'EC', 'longest prefix wins over +59x');
  assert.equal(phoneCountry('+4412345678'), 'ZZ');
});

test('address validation and normalisation', () => {
  assert.ok(isValidAddress('polygon', '0x' + 'aB'.repeat(20)));
  assert.ok(!isValidAddress('ethereum', '0x123'));
  assert.ok(isValidAddress('solana', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV'));
  assert.ok(!isValidAddress('solana', '0OIl' + 'a'.repeat(40)));
  assert.equal(normalizeAddress('base', '0xABC'), '0xabc');
});

test('OFAC report due date: 10 business days, skipping weekends', () => {
  // Friday 2026-11-13 + 10 business days = Friday 2026-11-27
  assert.equal(addBusinessDays(new Date('2026-11-13T15:00:00Z'), 10).toISOString().slice(0, 10), '2026-11-27');
  // Saturday start: first business day counted is Monday.
  assert.equal(addBusinessDays(new Date('2026-11-14T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-11-16');
});
