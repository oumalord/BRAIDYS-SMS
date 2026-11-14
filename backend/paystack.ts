import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyPaystackSignature(rawBody: Buffer | undefined, signature: unknown, secret: string): boolean {
  if (!rawBody || !Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !secret) return false;
  const provided = Buffer.from(signature, 'hex');
  const expected = createHmac('sha512', secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function toPaystackMinorAmount(amount: number, multiplier: number): number {
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(multiplier) || multiplier <= 0) return 0;
  const minorAmount = Math.round(amount * multiplier);
  return Number.isSafeInteger(minorAmount) ? minorAmount : 0;
}

export function hasSufficientPaystackPrincipalBalance(availableMinorUnits: number, transferAmounts: number[]): boolean {
  if (!Number.isSafeInteger(availableMinorUnits) || availableMinorUnits < 0) return false;
  if (!transferAmounts.length || transferAmounts.some(amount => !Number.isSafeInteger(amount) || amount <= 0)) return false;
  const requiredMinorUnits = transferAmounts.reduce((sum, amount) => sum + amount, 0);
  return Number.isSafeInteger(requiredMinorUnits) && availableMinorUnits >= requiredMinorUnits;
}

export const hasSufficientPaystackPrincipal = hasSufficientPaystackPrincipalBalance;
