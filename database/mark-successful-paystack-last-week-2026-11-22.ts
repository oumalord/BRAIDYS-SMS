import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import { calculateUnpaidStaffEarnings, currentSaturdayThroughFridayRange } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const collections = ['accounts', 'branches', 'staff', 'appointments', 'orders', 'payout_items', 'payroll_items', 'payroll_batches', 'audit_logs'];
const rowsByCollection = Object.fromEntries(await Promise.all(collections.map(async collection => [
  collection,
  await sql`SELECT id, tenant_id, record FROM app_records WHERE collection = ${collection}` as { id: string; tenant_id: string | null; record: Record<string, any> }[],
]))) as Record<string, { id: string; tenant_id: string | null; record: Record<string, any> }[]>;

const records = (collection: string) => rowsByCollection[collection].map(row => ({ ...row.record, id: row.id, tenantId: row.record.tenantId || row.tenant_id }));
const tenantId = String(process.env.RECONCILE_TENANT_ID || '');
let tenant = tenantId;
if (!tenant) {
  const owner = records('accounts').find(account => account.role === 'owner' && String(account.status || 'active') === 'active');
  tenant = String(owner?.tenantId || '');
}
if (!tenant) throw new Error('RECONCILE_TENANT_ID is required when no active owner account is found');

const asOf = new Date('2026-11-22T12:00:00+03:00');
const currentRange = currentSaturdayThroughFridayRange(asOf);
const lastWeekRange = currentSaturdayThroughFridayRange(new Date(currentRange.from - 7 * 24 * 3600 * 1000));

const staff = records('staff').filter(item => item.tenantId === tenant && !item.deletedAt);
const appointments = records('appointments').filter(item => item.tenantId === tenant && !item.deletedAt);
const orders = records('orders').filter(item => item.tenantId === tenant && !item.deletedAt);
const payoutItems = records('payout_items').filter(item => item.tenantId === tenant);
const payrollItems = records('payroll_items').filter(item => item.tenantId === tenant);
const payrollBatches = records('payroll_batches').filter(item => item.tenantId === tenant);

const grossLines = calculateUnpaidStaffEarnings(orders, [], appointments, lastWeekRange.from, lastWeekRange.to, []).filter(line => line.currency === 'KES');
const activeKeys = new Set(payoutItems.filter(item => !item.deletedAt).map(item => String(item.itemKey || '')).filter(Boolean));
const newLines = grossLines.filter(line => !activeKeys.has(line.itemKey));

if (newLines.length) {
  const now = Date.now();
  const rows = newLines.map(line => ({
    id: `paystack-reconciled-${createHash('sha256').update(`success:${line.itemKey}`).digest('hex')}`,
    tenantId, branchId: line.branchId || null, batchId: null, provider: 'paystack',
    reference: 'successful-paystack-reconciliation', itemKey: line.itemKey,
    orderId: line.orderId, staffId: line.staffId, serviceName: line.serviceName,
    role: line.role, amount: line.amount, currency: line.currency,
    orderCreatedAt: line.createdAt, reconciledAt: now, status: 'success', createdAt: now,
  }));
  for (const row of rows) {
    await sql`INSERT INTO app_records (id, collection, tenant_id, record)
      VALUES (${row.id}, 'payout_items', ${tenant}, ${JSON.stringify(row)}::jsonb)
      ON CONFLICT (collection, id) DO UPDATE SET record = EXCLUDED.record, tenant_id = EXCLUDED.tenant_id`;
  }
}

const paidKeys = new Set([...activeKeys, ...newLines.map(line => line.itemKey)]);
const matchingPayrollItems = payrollItems.filter(item => item.provider === 'paystack'
  && Array.isArray(item.itemKeys)
  && item.itemKeys.some((key: unknown) => paidKeys.has(String(key))));

for (const item of matchingPayrollItems) {
  await sql`UPDATE app_records SET record = ${JSON.stringify({ ...item, status: 'success', paidAt: Date.now(), reconciledAt: Date.now() })}::jsonb
    WHERE collection = 'payroll_items' AND id = ${item.id}`;
}

const matchingBatchIds = new Set(matchingPayrollItems.map(item => String(item.batchId || '')).filter(Boolean));
for (const batch of payrollBatches.filter(item => matchingBatchIds.has(String(item.id)))) {
  await sql`UPDATE app_records SET record = ${JSON.stringify({ ...batch, status: 'success', sentCount: batch.employeeCount || matchingPayrollItems.length, failedCount: 0, reconciledAt: Date.now() })}::jsonb
    WHERE collection = 'payroll_batches' AND id = ${batch.id}`;
}

console.log(JSON.stringify({ tenantId: tenant, period: lastWeekRange, staffCount: staff.length, grossLineCount: grossLines.length, markedPaidCount: newLines.length, markedPayrollItemCount: matchingPayrollItems.length }, null, 2));
