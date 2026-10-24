import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { toPaystackMinorAmount, verifyPaystackSignature } from '../backend/paystack.ts';

test('Paystack webhook signature validates only the exact raw payload', () => {
  const payload = Buffer.from('{"event":"transfer.success"}');
  const secret = 'test-secret';
  const signature = createHmac('sha512', secret).update(payload).digest('hex');

  assert.equal(verifyPaystackSignature(payload, signature, secret), true);
  assert.equal(verifyPaystackSignature(Buffer.from('{ "event":"transfer.success"}'), signature, secret), false);
  assert.equal(verifyPaystackSignature(payload, signature, 'wrong-secret'), false);
  assert.equal(verifyPaystackSignature(undefined, signature, secret), false);
});

test('Paystack amounts are converted with a configured minor-unit multiplier', () => {
  assert.equal(toPaystackMinorAmount(1250, 100), 125000);
  assert.equal(toPaystackMinorAmount(0, 100), 0);
  assert.equal(toPaystackMinorAmount(1250, 0), 0);
});