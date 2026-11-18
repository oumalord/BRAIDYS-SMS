import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const from = Date.parse('2026-11-01T00:00:00+03:00');
const now = Date.now();
const to = now + 1;
const reason = 'Owner requested removal of exact duplicate orders from the live staff dashboard audit; earliest matching order retained.';
const sql = neon(databaseUrl);
const loadTenantRows = async (collection: string) => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = ${collection}
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
` as any[];
const loadDashboardOrders = async () => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND NOT (record ? 'deletedAt')
    AND (record->>'createdAt')::numeric >= ${from}
    AND (record->>'createdAt')::numeric < ${to}
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
const appointmentsById = new Map(appointments.map(item => [String(item.id), item]));
const stableStringify = (value: any): string => Array.isArray(value)
  ? `[${value.map(stableStringify).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const signature = (order: any) => {
  const appointment = appointmentsById.get(String(order.appointmentId || ''));
  return stableStringify({
    appointmentId: order.appointmentId || null,
    customerId: order.customerId || null,
    customerName: String(order.customerName || '').trim().toLowerCase().replace(/\s+/g, ' '),
    branchId: order.branchId || appointment?.branchId || null,
    paymentMethod: order.paymentMethod || null,
    mpesaReceiptNumber: order.mpesaReceiptNumber || null,
    totalByCurrency: order.totalByCurrency || {},
    items: order.items || [],
  });
};

const bySignature = new Map<string, any[]>();
for (const order of orders) {
  if (!order.appointmentId) continue;
  const appointment = appointmentsById.get(String(order.appointmentId));
  if (!appointment || appointment.deletedAt) continue;
  const key = signature(order);
  const group = bySignature.get(key) || [];
  group.push(order);
  bySignature.set(key, group);
}
const duplicateGroups = Array.from(bySignature.values()).filter(group => group.length > 1)
  .map(group => group.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0)));
const targets = duplicateGroups.flatMap(group => group.slice(1));
const targetIds = targets.map(order => String(order.id));
const payoutReferences = payoutItems.filter(item => targetIds.includes(String(item.orderId || ''))
  || targetIds.some(id => String(item.itemKey || '').startsWith(`${id}:`)));
if (payoutReferences.length) throw new Error('An exact duplicate has payout history; refusing to alter it');
for (const order of targets) {
  if (order.customerId) throw new Error(`Duplicate order ${order.id} has a customer account; refusing to alter loyalty totals`);
  const hasInventory = (order.items || []).some((item: any) => item.type === 'product' && item.refId
    || (item.consumedProducts || []).some((used: any) => used.productId && Number(used.qty || 0) !== 0));
  if (hasInventory) throw new Error(`Duplicate order ${order.id} has inventory effects requiring separate reversal`);
}

const dashboardLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, from, to)
  .filter(line => line.currency === 'KES');
const duplicateLines = dashboardLines.filter(line => targetIds.includes(line.orderId));
const duplicateTotal = duplicateLines.reduce((sum, line) => sum + line.amount, 0);
const currentTotal = dashboardLines.reduce((sum, line) => sum + line.amount, 0);
const projectedTotal = currentTotal - duplicateTotal;
const summary = {
  currentDashboardUnpaidKES: currentTotal,
  duplicateEarningsKES: duplicateTotal,
  projectedDashboardUnpaidKES: projectedTotal,
  currentLines: dashboardLines.length,
  duplicateLines: duplicateLines.length,
  duplicateGroups: duplicateGroups.map(group => ({
    appointmentId: String(group[0].appointmentId),
    orderIdsInCreatedOrder: group.map(order => String(order.id)),
    voidOrderIds: group.slice(1).map(order => String(order.id)),
  })),
  payoutReferences: payoutReferences.length,
};

if (!process.argv.includes('--confirm')) {
  console.log(JSON.stringify({ dryRun: true, ...summary, action: 'No records changed. Pass --confirm to void later exact duplicate orders.' }, null, 2));
} else if (!targetIds.length) {
  console.log(JSON.stringify({ corrected: false, ...summary, action: 'No exact dashboard duplicates found; no records changed.' }, null, 2));
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
      AND id = ANY(${targetIds})
      AND NOT (record ? 'deletedAt')
      AND (
        SELECT COUNT(*) FROM app_records
        WHERE collection = 'orders' AND id = ANY(${targetIds}) AND NOT (record ? 'deletedAt')
      ) = ${targetIds.length}
    RETURNING id
  ` as { id: string }[];
  if (updatedRows.length !== targetIds.length) throw new Error(`Expected to void ${targetIds.length} orders, voided ${updatedRows.length}`);

  for (const id of targetIds) {
    const auditId = randomUUID();
    const order = targets.find(item => String(item.id) === id)!;
    await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (
      ${auditId}, 'audit_logs', ${tenantId}, ${JSON.stringify({
        id: auditId, tenantId, branchId: order.branchId || null,
        action: 'voided duplicate order', collection: 'order', actor: 'owner', recordId: id,
        summary: `voided duplicate order: ${order.customerName || 'Walk-in Customer'}`,
        recordSnapshot: order, reason, createdAt: deletedAt,
      })}::jsonb
    )`;
  }
  const statusRows = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${targetIds})` as any[];
  const verified = statusRows.filter(row => row.record?.deletedAt && row.record?.voidReason === reason).length;
  const finalLines = calculateUnpaidStaffEarnings(
    orders.map(order => targetIds.includes(String(order.id)) ? { ...order, deletedAt } : order),
    payoutItems, appointments, from, Date.now() + 1,
  ).filter(line => line.currency === 'KES');
  const finalTotal = finalLines.reduce((sum, line) => sum + line.amount, 0);
  if (verified !== targetIds.length || finalTotal !== projectedTotal) throw new Error(`Post-correction verification failed: voided=${verified}, total=${finalTotal}`);
  console.log(JSON.stringify({ corrected: true, ...summary, finalDashboardUnpaidKES: finalTotal, voidedOrderIds: targetIds, reason }, null, 2));
}