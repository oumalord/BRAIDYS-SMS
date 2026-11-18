import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const from = Date.parse('2026-11-01T00:00:00+03:00');
const appointmentId = '4c9beb7e-21df-48c0-99b6-5a23557bfb81';
const keepId = '2235138d-e52b-4ddb-92ac-5e093c472763';
const duplicateId = '163db93a-c80e-4284-b816-29be1812a815';
const reason = 'Owner requested removal of exact duplicate Njeru order from the live staff earnings audit; earlier matching order retained.';
const sql = neon(databaseUrl);
const targetIds = [keepId, duplicateId];
const loadTenantRows = async (collection: string) => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = ${collection}
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
` as any[];
const loadDashboardOrders = async () => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND (
      id = ANY(${targetIds})
      OR (
        NOT (record ? 'deletedAt')
        AND (record->>'createdAt')::numeric >= ${from}
        AND (record->>'createdAt')::numeric < ${Date.now() + 1}
      )
    )
` as any[];
const [orderRows, appointmentRows, payoutRows] = await Promise.all([
  loadDashboardOrders(), loadTenantRows('appointments'), loadTenantRows('payout_items'),
]);
const records = (rows: any[]) => rows.map(row => ({
  ...row.record,
  id: String(row.id),
  tenantId: row.record?.tenantId || row.tenant_id,
}));
const orders = records(orderRows);
const appointments = records(appointmentRows);
const payoutItems = records(payoutRows);
const kept = orders.find(order => String(order.id) === keepId);
const duplicate = orders.find(order => String(order.id) === duplicateId);
const appointment = appointments.find(item => String(item.id) === appointmentId);
if (!kept || !duplicate || kept.deletedAt || duplicate.deletedAt || !appointment || appointment.deletedAt
  || kept.appointmentId !== appointmentId || duplicate.appointmentId !== appointmentId) {
  throw new Error('The active Njeru duplicate pair or appointment did not match');
}
const stableStringify = (value: any): string => Array.isArray(value)
  ? `[${value.map(stableStringify).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const signature = (order: any) => stableStringify({
  appointmentId: order.appointmentId || null,
  customerId: order.customerId || null,
  customerName: String(order.customerName || '').trim().toLowerCase().replace(/\s+/g, ' '),
  branchId: order.branchId || appointment.branchId || null,
  paymentMethod: order.paymentMethod || null,
  mpesaReceiptNumber: order.mpesaReceiptNumber || null,
  totalByCurrency: order.totalByCurrency || {},
  items: order.items || [],
});
if (signature(kept) !== signature(duplicate) || Number(kept.createdAt || 0) >= Number(duplicate.createdAt || 0)) {
  throw new Error('The two Njeru orders are not an exact duplicate pair in chronological order');
}
if (kept.customerId || duplicate.customerId) throw new Error('A duplicate order has a customer account; refusing to alter loyalty totals');
const hasInventory = [kept, duplicate].some(order => (order.items || []).some((item: any) =>
  item.type === 'product' && item.refId || (item.consumedProducts || []).some((used: any) => used.productId && Number(used.qty || 0) !== 0)));
if (hasInventory) throw new Error('The duplicate order has inventory effects requiring separate reversal');
const payoutReferences = payoutItems.filter(item => targetIds.includes(String(item.orderId || ''))
  || targetIds.some(id => String(item.itemKey || '').startsWith(`${id}:`)));
if (payoutReferences.length) throw new Error('The Njeru duplicate has payout history; refusing to void it');

const now = Date.now();
const dashboardLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, from, now + 1)
  .filter(line => line.currency === 'KES');
const duplicateLines = dashboardLines.filter(line => line.orderId === duplicateId);
const duplicateTotal = duplicateLines.reduce((sum, line) => sum + line.amount, 0);
if (duplicateLines.length !== 1 || duplicateTotal !== 750) throw new Error(`Expected one KES 750 duplicate line, found ${duplicateLines.length} / KES ${duplicateTotal}`);
const currentTotal = dashboardLines.reduce((sum, line) => sum + line.amount, 0);
const projectedTotal = currentTotal - duplicateTotal;

if (!process.argv.includes('--confirm')) {
  console.log(JSON.stringify({
    dryRun: true,
    appointmentId,
    keepOrderId: keepId,
    duplicateOrderId: duplicateId,
    currentDashboardUnpaidKES: currentTotal,
    duplicateEarningsKES: duplicateTotal,
    projectedDashboardUnpaidKES: projectedTotal,
    payoutReferences: payoutReferences.length,
    action: 'No records changed. Pass --confirm to void the later exact duplicate.',
  }, null, 2));
} else {
  const deletedAt = Date.now();
  const updatedRows = await sql`
    UPDATE app_records
    SET record = record || jsonb_build_object(
      'deletedAt', ${deletedAt}::bigint,
      'deletedBy', 'owner',
      'voidReason', ${reason}::text
    )
    WHERE collection = 'orders'
      AND id = ${duplicateId}
      AND NOT (record ? 'deletedAt')
    RETURNING id
  ` as { id: string }[];
  if (updatedRows.length !== 1) throw new Error(`Expected to void one order, voided ${updatedRows.length}`);

  const auditId = randomUUID();
  await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (
    ${auditId}, 'audit_logs', ${tenantId}, ${JSON.stringify({
      id: auditId, tenantId, branchId: duplicate.branchId || null,
      action: 'voided duplicate order', collection: 'order', actor: 'owner', recordId: duplicateId,
      summary: `voided duplicate order: ${duplicate.customerName || 'Walk-in Customer'}`,
      recordSnapshot: duplicate, reason, createdAt: deletedAt,
    })}::jsonb
  )`;
  const verifiedRows = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ${duplicateId}` as any[];
  const verified = verifiedRows.length === 1 && verifiedRows[0].record?.deletedAt && verifiedRows[0].record?.voidReason === reason;
  const finalTotal = calculateUnpaidStaffEarnings(
    orders.map(order => String(order.id) === duplicateId ? { ...order, deletedAt } : order),
    payoutItems, appointments, from, Date.now() + 1,
  ).filter(line => line.currency === 'KES').reduce((sum, line) => sum + line.amount, 0);
  if (!verified || finalTotal !== projectedTotal) throw new Error(`Post-correction verification failed: voided=${verified}, total=${finalTotal}`);
  console.log(JSON.stringify({ corrected: true, voidedOrderId: duplicateId, retainedOrderId: keepId, removedEarningsKES: duplicateTotal, dashboardUnpaidKES: finalTotal, reason }, null, 2));
}