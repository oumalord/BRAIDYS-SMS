import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../backend/index.ts', import.meta.url), 'utf8');

test('backend has no duplicate API route declarations', () => {
  const matches = [...source.matchAll(/^\s*'((?:GET|POST|PUT|DELETE|PATCH) \/api[^']+)':/gm)].map(match => match[1]);
  const counts = new Map<string, number>();
  for (const route of matches) counts.set(route, (counts.get(route) || 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
  assert.deepEqual(duplicates, [], `Duplicate API routes found: ${duplicates.map(([route]) => route).join(', ')}`);
});

test('essential booking, POS, catalog and payroll routes remain present', () => {
  const required = [
    'POST /api/appointments',
    'GET /api/appointments',
    'POST /api/orders',
    'GET /api/staff',
    'GET /api/services',
    'GET /api/customers',
    'GET /api/payroll/staff',
    'POST /api/payroll/paystack/send',
    'POST /api/payroll/paystack/recipients/sync',
  ];
  for (const route of required) assert.match(source, new RegExp(`^\\s*'${route.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}':`, 'm'), `${route} is missing`);
});
