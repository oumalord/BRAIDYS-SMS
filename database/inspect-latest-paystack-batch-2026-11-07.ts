import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const tenantId = 'salon-852a7423ca75d9db';
const batchRows = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'payroll_batches'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'provider' = 'paystack'
  ORDER BY (record->>'createdAt')::numeric DESC
  LIMIT 5
` as any[];
const batches = batchRows.map(row => ({ ...row.record, id: String(row.id) }));
const batchIds = batches.map(batch => String(batch.id));
const itemRows = batchIds.length ? await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'payroll_items'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'provider' = 'paystack'
    AND record->>'batchId' = ANY(${batchIds})
` as any[] : [];
const items = itemRows.map(row => ({ ...row.record, id: String(row.id) }));
console.log(JSON.stringify({
  batches: batches.map(batch => ({
    id: batch.id, status: batch.status, totalKES: batch.totalKES, employeeCount: batch.employeeCount,
    failedCount: batch.failedCount, error: batch.error, providerFailure: batch.providerFailure || null, createdAt: batch.createdAt,
  })),
  transfers: items.map(item => ({
    batchId: item.batchId, staffId: item.staffId, staffName: item.staffName,
    amountKES: item.amountKES, amount: item.amount, currency: item.currency,
    referenceLength: String(item.reference || '').length,
    referenceValid: /^[a-z0-9]{16,50}$/.test(String(item.reference || '')),
    referenceStartsWithLetter: /^[a-z]/.test(String(item.reference || '')),
    referenceIsLowercaseHex32: /^[a-f0-9]{32}$/.test(String(item.reference || '')),
    providerFailure: item.providerFailure || null,
    status: item.status, error: item.error,
  })),
}, null, 2));
