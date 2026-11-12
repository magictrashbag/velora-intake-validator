import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount, MoneyError, usdCentsEquivalent } from '../src/money.ts';
import { parseRate, convert, applySpreadBps } from '../src/fx.ts';

test('parses exact decimals into minor units', () => {
  assert.equal(parseAmount('10', 'USDC').minor, 10_000_000n);
  assert.equal(parseAmount('10.5', 'USDC').minor, 10_500_000n);
  assert.equal(parseAmount('0.000001', 'USDC').minor, 1n);
  assert.equal(parseAmount('1234.56', 'VES').minor, 123456n);
});

test('rejects anything ambiguous instead of rounding', () => {
  for (const bad of ['', '-1', '1e3', '1,5', '0', '0.00', ' .5', 'NaN', '1.2.3']) {
    assert.throws(() => parseAmount(bad, 'USDC'), MoneyError, bad);
  }
  assert.throws(() => parseAmount('1.001', 'VES'), /at most 2 decimal/);
  assert.throws(() => parseAmount('999999999999999', 'USDC'), /too large/, 'would overflow Postgres bigint');
  assert.equal(parseAmount('1000000000', 'USDC').minor, 10n ** 15n);
});

test('formats round-trip', () => {
  assert.equal(formatAmount(parseAmount('10.5', 'USDC')), '10.500000');
  assert.equal(formatAmount(parseAmount('10.5', 'USDC'), { trimZeros: true }), '10.5');
  assert.equal(formatAmount({ currency: 'VES', minor: -5n }), '-0.05');
});

test('USD equivalent for limits rounds UP (never in the customer\'s favour)', () => {
  assert.equal(usdCentsEquivalent({ currency: 'USDC', minor: 1_990_000n }), 199n);
  assert.equal(usdCentsEquivalent({ currency: 'USDC', minor: 1_990_001n }), 200n);
  assert.equal(usdCentsEquivalent(parseAmount('500.009999', 'USDC')), 50001n);
  assert.equal(usdCentsEquivalent({ currency: 'VES', minor: 100n }), null);
});

test('FX converts both directions with exact rationals, rounding down', () => {
  const r = parseRate('USDC', 'VES', '36.4512');
  assert.equal(convert(parseAmount('100', 'USDC'), r).minor, 364512n); // Bs 3645.12
  // 1000 Bs / 36.4512 = 27.4339390747... USDC -> floor at 6dp
  assert.equal(convert(parseAmount('1000', 'VES'), r).minor, 27_433_939n);
  assert.throws(() => convert(parseAmount('1', 'USD'), r), MoneyError);
});

test('spread always moves the rate against the customer', () => {
  const mid = parseRate('USDC', 'VES', '40');
  const sellUsd = applySpreadBps(mid, 100, 'base'); // customer sells USDC, gets Bs
  const buyUsd = applySpreadBps(mid, 100, 'quote'); // customer sells Bs, gets USDC
  const hundred = parseAmount('100', 'USDC');
  assert.equal(convert(hundred, sellUsd).minor, 396000n); // Bs 3960 < 4000
  assert.ok(convert(parseAmount('4000', 'VES'), buyUsd).minor < 100_000_000n);
});
