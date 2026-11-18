import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const from = Date.parse('2026-11-01T00:00:00+03:00');
const to = Date.parse('2026-11-07T00:00:00+03:00');
const targets = [
  { orderId: '341f41aa-1ba1-4453-ae62-ed772584239b', appointmentId: 'c05e77ee-6d04-4a8f-84b8-122251394e91' },
  { orderId: '6c67843b-f553-4e80-ac88-4991dcccdb58', appointmentId: '48ce279d-f4c3-4ace-8424-980f91ab2b25' },
];
const targetOrderIds = targets.map(item => item.orderId);
const targetAppointmentIds = targets.map(item => item.appointmentId);
const reason = 'Order is linked to a deleted appointment and must not contribute active staff earnings.';
const sql = neon(databaseUrl);
if (process.argv.includes('--status')) {
  const [orders, audits] = await Promise.all([
    sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${targetOrderIds})`,
    sql`SELECT record FROM app_records WHERE collection = 'audit_logs' AND record->>'recordId' = ANY(${targetOrderIds})`,
  ]) as any[][];
  console.log(JSON.stringify({
    orders: orders.map(row => ({ id: String(row.id), deletedAt: row.record?.deletedAt || null, voidReason: row.record?.voidReason || null })),
    auditEntries: audits.length,
  }, null, 2));
  process.exit(0);
}
const loadTenantRows = async (collection: string) => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = ${collection}
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
` as any[];
const loadWindowOrders = async () => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND (
      id = ANY(${targetOrderIds})
      OR (
        NOT (record ? 'deletedAt')
        AND (record->>'createdAt')::numeric >= ${from}
        AND (record->>'createdAt')::numeric < ${to}
      )
    )
` as any[];
const [orderRows, appointmentRows, payoutRows] = await Promise.all([
  loadWindowOrders(), loadTenantRows('appointments'), loadTenantRows('payout_items'),
]);
const records = (rows: any[]) => rows.map(row => ({
  ...row.record,
  id: String(row.id),
  tenantId: row.record?.tenantId || row.tenant_id,
}));
const orders = records(orderRows);
const appointments = records(appointmentRows);
const payoutItems = records(payoutRows);
const ordersById = new Map(orders.map(order => [String(order.id), order]));
const appointmentsById = new Map(appointments.map(item => [String(item.id), item]));

for (const target of targets) {
  const order = ordersById.get(target.orderId);
  const appointment = appointmentsById.get(target.appointmentId);
  if (!order || order.deletedAt || !appointment?.deletedAt || String(order.appointmentId || '') !== target.appointmentId) {
    throw new Error(`Order ${target.orderId} is not active and linked to the expected deleted appointment`);
  }
  if (order.customerId) throw new Error(`Order ${target.orderId} has a customer balance requiring separate recalculation`);
  const hasInventory = (order.items || []).some((item: any) => item.type === 'product' && item.refId
    || (item.consumedProducts || []).some((used: any) => used.productId && Number(used.qty || 0) !== 0));
  if (hasInventory) throw new Error(`Order ${target.orderId} has inventory effects requiring separate reversal`);
}
const payoutReferences = payoutItems.filter(item => targetOrderIds.includes(String(item.orderId || ''))
  || targetOrderIds.some(id => String(item.itemKey || '').startsWith(`${id}:`)));
if (payoutReferences.length) throw new Error('A deleted-appointment order has payout history; refusing to alter it');

const grossLines = calculateUnpaidStaffEarnings(orders, [], appointments, from, to);
const targetLines = grossLines.filter(line => targetOrderIds.includes(line.orderId));
const targetTotal = targetLines.reduce((sum, line) => sum + line.amount, 0);
if (targetLines.length !== 5 || targetTotal !== 1975) {
  throw new Error(`Refusing cleanup: found ${targetLines.length} lines / KES ${targetTotal}; expected 5 / KES 1,975`);
}
const currentTotal = grossLines.reduce((sum, line) => sum + line.amount, 0);
const projectedTotal = currentTotal - targetTotal;
const confirmed = process.argv.includes('--confirm');
if (!confirmed) {
  console.log(JSON.stringify({
    dryRun: true,
    deletedAppointmentOrders: targets,
    currentEarningsKES: currentTotal,
    unmatchedEarningsKES: targetTotal,
    projectedEarningsKES: projectedTotal,
    earningLinesToRemove: targetLines.map(line => ({ orderId: line.orderId, staffId: line.staffId, role: line.role, service: line.serviceName, amount: line.amount })),
    payoutReferences: payoutReferences.length,
    action: 'No records changed. Pass --confirm to soft-delete these orders and audit the correction.',
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
      AND id = ANY(${targetOrderIds})
      AND NOT (record ? 'deletedAt')
      AND (
        SELECT COUNT(*) FROM app_records
        WHERE collection = 'orders' AND id = ANY(${targetOrderIds}) AND NOT (record ? 'deletedAt')
      ) = ${targetOrderIds.length}
    RETURNING id
  ` as { id: string }[];
  if (updatedRows.length !== targetOrderIds.length) throw new Error(`Expected to void ${targetOrderIds.length} orders, voided ${updatedRows.length}`);

  for (const id of targetOrderIds) {
    const auditId = randomUUID();
    const order = ordersById.get(id)!;
    await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (
      ${auditId}, 'audit_logs', ${tenantId}, ${JSON.stringify({
        id: auditId, tenantId, branchId: order.branchId || null,
        action: 'voided order linked to deleted appointment', collection: 'order', actor: 'owner', recordId: id,
        summary: `voided order linked to deleted appointment: ${order.customerName || 'Walk-in Customer'}`,
        recordSnapshot: order, reason, createdAt: deletedAt,
      })}::jsonb
    )`;
  }

  const finalRows = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${targetOrderIds})` as any[];
  const verifiedVoids = finalRows.filter(row => row.record?.deletedAt && row.record?.voidReason === reason).length;
  const finalLines = calculateUnpaidStaffEarnings(
    orders.map(order => targetOrderIds.includes(String(order.id)) ? { ...order, deletedAt } : order),
    payoutItems, appointments, from, to,
  );
  const finalTotal = finalLines.reduce((sum, line) => sum + line.amount, 0);
  if (verifiedVoids !== targetOrderIds.length || finalTotal !== projectedTotal) {
    throw new Error(`Post-cleanup verification failed: voided=${verifiedVoids}, total=${finalTotal}`);
  }
  console.log(JSON.stringify({
    corrected: true,
    voidedOrderIds: targetOrderIds,
    removedEarningsKES: targetTotal,
    finalEarningsKES: finalTotal,
    reason,
  }, null, 2));
}