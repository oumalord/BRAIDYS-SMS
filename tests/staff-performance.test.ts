import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uniqueServiceLines } from '../src/lib/staffPerformance.ts';

test('shared service revenue is counted once even when assistant attribution follows commission attribution', () => {
  const lines = [
    { lineId: 'order-1:0', staffId: 'primary', attributedRevenue: 1800 },
    { lineId: 'order-1:0', staffId: 'assistant', attributedRevenue: 0 },
    { lineId: 'order-2:0', staffId: 'stylist', attributedRevenue: 600 },
  ];

  const unique = uniqueServiceLines(lines);

  assert.equal(unique.length, 2);
  assert.deepEqual(unique.map(line => line.attributedRevenue), [1800, 600]);
  assert.equal(unique.reduce((total, line) => total + line.attributedRevenue, 0), 2400);
});