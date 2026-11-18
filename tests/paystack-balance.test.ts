import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasSufficientPaystackPrincipalBalance } from '../backend/paystack.ts';

test('Paystack balance preflight accepts enough principal balance', () => {
  assert.equal(hasSufficientPaystackPrincipalBalance(350000, [100000, 250000]), true);
});

test('Paystack balance preflight rejects an insufficient balance', () => {
  assert.equal(hasSufficientPaystackPrincipalBalance(349999, [100000, 250000]), false);
});

test('Paystack balance preflight rejects empty, invalid, and overflowing transfer amounts', () => {
  assert.equal(hasSufficientPaystackPrincipalBalance(100, []), false);
  assert.equal(hasSufficientPaystackPrincipalBalance(100, [0]), false);
  assert.equal(hasSufficientPaystackPrincipalBalance(100, [Number.MAX_SAFE_INTEGER, 1]), false);
  assert.equal(hasSufficientPaystackPrincipalBalance(Number.NaN, [100]), false);
});