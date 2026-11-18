import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const from = Date.parse('2026-11-01T00:00:00+03:00');
const pairs = [
  { keep: '84bb0449-69c2-4308-b720-2efbe74856e5', duplicate: '97dd5052-3f1e-4685-a5a1-35c8347ac10b', appointmentId: 'a320fc21-3388-480c-9219-13ffae48e568' },
  { keep: '511de818-8187-40a0-9ba5-fa488190a30f', duplicate: '30fa04e4-88b2-45ca-a538-4a4653a615f6', appointmentId: '928d0467-0b06-4536-a548-78960e6bb4cb' },
];
const duplicateIds = pairs.map(pair => pair.duplicate);
const allPairIds = pairs.flatMap(pair => [pair.keep, pair.duplicate]);
const reason = 'Owner requested removal of exact duplicate orders from the live staff dashboard audit; earliest matching order retained.';
const sql = neon(databaseUrl);
if (process.argv.includes('--status')) {
  const [orders, audits] = await Promise.all([
    sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${duplicateIds})`,
    sql`SELECT record FROM app_records WHERE collection = 'audit_logs' AND record->>'recordId' = ANY(${duplicateIds}) AND record->>'action' = 'voided duplicate order'`,
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
const loadDashboardOrders = async () => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND (
      id = ANY(${allPairIds})
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
const ordersById = new Map(orders.map(order => [String(order.id), order]));
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
const now = Date.now();
for (const pair of pairs) {
  const kept = ordersById.get(pair.keep);
  const duplicate = ordersById.get(pair.duplicate);
  const appointment = appointmentsById.get(pair.appointmentId);
  if (!kept || !duplicate || kept.deletedAt || duplicate.deletedAt) throw new Error(`Expected active pair ${pair.keep}/${pair.duplicate} was not found`);
  if (!appointment || appointment.deletedAt || kept.appointmentId !== pair.appointmentId || duplicate.appointmentId !== pair.appointmentId) {
    throw new Error(`Order pair ${pair.keep}/${pair.duplicate} does not match the active appointment`);
  }
  if (signature(kept) !== signature(duplicate)) throw new Error(`Orders ${pair.keep}/${pair.duplicate} are not exact matches`);
  if (Number(kept.createdAt || 0) >= Number(duplicate.createdAt || 0)) throw new Error(`Order ${pair.keep} is not earlier than ${pair.duplicate}`);
  if (Number(kept.createdAt || 0) < from || Number(duplicate.createdAt || 0) < from || Number(duplicate.createdAt || 0) >= now + 1) {
    throw new Error(`Order pair ${pair.keep}/${pair.duplicate} is outside the live dashboard period`);
  }
  if (kept.customerId || duplicate.customerId) throw new Error('A duplicate order has a customer account; refusing to alter loyalty totals');
  const hasInventory = [kept, duplicate].some(order => (order.items || []).some((item: any) =>
    item.type === 'product' && item.refId || (item.consumedProducts || []).some((used: any) => used.productId && Number(used.qty || 0) !== 0)));
  if (hasInventory) throw new Error(`Order pair ${pair.keep}/${pair.duplicate} has inventory effects requiring separate reversal`);
}
const payoutReferences = payoutItems.filter(item => allPairIds.includes(String(item.orderId || ''))
  || allPairIds.some(id => String(item.itemKey || '').startsWith(`${id}:`)));
if (payoutReferences.length) throw new Error('A dashboard duplicate order has payout history; refusing to void it');

const dashboardLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, from, now + 1)
  .filter(line => line.currency === 'KES');
const duplicateLines = dashboardLines.filter(line => duplicateIds.includes(line.orderId));
const currentTotal = dashboardLines.reduce((sum, line) => sum + line.amount, 0);
const duplicateTotal = duplicateLines.reduce((sum, line) => sum + line.amount, 0);
const projectedTotal = dashboardLines.filter(line => !duplicateIds.includes(line.orderId)).reduce((sum, line) => sum + line.amount, 0);
if (currentTotal !== 285739.525 || duplicateTotal !== 2080 || projectedTotal !== 283659.525
  || dashboardLines.length !== 657 || duplicateLines.length !== 6) {
  throw new Error(`Refusing correction: current=${currentTotal}, duplicate=${duplicateTotal}, projected=${projectedTotal}, lines=${dashboardLines.length}/${duplicateLines.length}; expected 285739.525/2080/283659.525 and 657/6.`);
}

const confirmed = process.argv.includes('--confirm');
if (!confirmed) {
  console.log(JSON.stringify({
    dryRun: true,
    currentDashboardUnpaidKES: currentTotal,
    duplicateEarningsKES: duplicateTotal,
    projectedDashboardUnpaidKES: projectedTotal,
    currentLines: dashboardLines.length,
    duplicateLines: duplicateLines.length,
    payoutReferences: payoutReferences.length,
    ordersToVoid: pairs.map(pair => ({ keep: pair.keep, void: pair.duplicate, appointmentId: pair.appointmentId })),
    action: 'No records changed. Pass --confirm to void the two exact later duplicate orders.',
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
      AND id = ANY(${duplicateIds})
      AND NOT (record ? 'deletedAt')
      AND (
        SELECT COUNT(*) FROM app_records
        WHERE collection = 'orders' AND id = ANY(${duplicateIds}) AND NOT (record ? 'deletedAt')
      ) = ${duplicateIds.length}
    RETURNING id
  ` as { id: string }[];
  if (updatedRows.length !== duplicateIds.length) throw new Error(`Expected to void ${duplicateIds.length} orders, voided ${updatedRows.length}`);

  for (const id of duplicateIds) {
    const auditId = randomUUID();
    const order = ordersById.get(id)!;
    await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (
      ${auditId}, 'audit_logs', ${tenantId}, ${JSON.stringify({
        id: auditId, tenantId, branchId: order.branchId || null,
        action: 'voided duplicate order', collection: 'order', actor: 'owner', recordId: id,
        summary: `voided duplicate order: ${order.customerName || 'Walk-in Customer'}`,
        recordSnapshot: order, reason, createdAt: deletedAt,
      })}::jsonb
    )`;
  }
  const finalRows = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${duplicateIds})` as any[];
  const verifiedVoids = finalRows.filter(row => row.record?.deletedAt && row.record?.voidReason === reason).length;
  const finalDashboardLines = calculateUnpaidStaffEarnings(
    orders.map(order => duplicateIds.includes(String(order.id)) ? { ...order, deletedAt } : order),
    payoutItems, appointments, from, Date.now() + 1,
  ).filter(line => line.currency === 'KES');
  const finalTotal = finalDashboardLines.reduce((sum, line) => sum + line.amount, 0);
  if (verifiedVoids !== duplicateIds.length || finalTotal !== projectedTotal || finalDashboardLines.length !== dashboardLines.length - duplicateLines.length) {
    throw new Error(`Post-correction verification failed: voided=${verifiedVoids}, total=${finalTotal}, lines=${finalDashboardLines.length}`);
  }
  console.log(JSON.stringify({
    corrected: true,
    voidedOrderIds: duplicateIds,
    retainedOrderIds: pairs.map(pair => pair.keep),
    removedEarningsKES: duplicateTotal,
    dashboardUnpaidKES: finalTotal,
    dashboardLines: finalDashboardLines.length,
    reason,
  }, null, 2));
}