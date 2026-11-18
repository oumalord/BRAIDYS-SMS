import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const from = Date.parse('2026-11-01T00:00:00+03:00');
const to = Date.parse('2026-11-07T00:00:00+03:00');
const pairs = [
  { keep: 'fa9d1f2a-0016-4019-9f4d-66944d7cf3b5', duplicate: '16e18006-b858-4611-8400-242faff5897e', appointmentId: '05acbe71-fa7c-40ff-9a44-5bef24557c9c' },
  { keep: 'a276e081-11ff-4bd6-b33f-165fcbcaf54b', duplicate: '9972fc20-3c24-431b-a8fc-242a29497c83', appointmentId: '8367b4c7-a522-4040-babf-fe6c1ed26e3b' },
];
const duplicateIds = pairs.map(pair => pair.duplicate);
const allPairIds = pairs.flatMap(pair => [pair.keep, pair.duplicate]);
const reason = 'Owner requested appointment reconciliation; later same-amount service variant duplicates the booked-service order, which is retained.';
const sql = neon(databaseUrl);
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
      id = ANY(${allPairIds})
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
const stableStringify = (value: any): string => Array.isArray(value)
  ? `[${value.map(stableStringify).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const serviceComparable = (order: any) => ({
  customerId: order.customerId || null,
  customerName: String(order.customerName || '').trim().toLowerCase().replace(/\s+/g, ' '),
  paymentMethod: order.paymentMethod || null,
  mpesaReceiptNumber: order.mpesaReceiptNumber || null,
  totalByCurrency: order.totalByCurrency || {},
  items: (order.items || []).map((item: any) => item.type === 'service' ? { ...item, name: '__SERVICE__', refId: '__SERVICE__' } : item),
});
const serviceSignature = (order: any) => stableStringify(serviceComparable(order));
const findDifferences = (left: any, right: any, path = ''): any[] => {
  if (stableStringify(left) === stableStringify(right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) return left.flatMap((value, index) => findDifferences(value, right[index], `${path}[${index}]`));
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    return Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).flatMap(key => findDifferences(left[key], right[key], path ? `${path}.${key}` : key));
  }
  return [{ path, kept: left ?? null, variant: right ?? null }];
};

for (const pair of pairs) {
  const kept = ordersById.get(pair.keep);
  const duplicate = ordersById.get(pair.duplicate);
  const appointment = appointmentsById.get(pair.appointmentId);
  if (!kept || !duplicate || kept.deletedAt || duplicate.deletedAt) throw new Error(`Expected active pair ${pair.keep}/${pair.duplicate} was not found`);
  if (!appointment || appointment.deletedAt || kept.appointmentId !== pair.appointmentId || duplicate.appointmentId !== pair.appointmentId) {
    throw new Error(`Order pair ${pair.keep}/${pair.duplicate} does not share the expected active appointment`);
  }
  const keptServiceName = String(kept.items?.[0]?.name || '').trim().toLowerCase();
  const duplicateServiceName = String(duplicate.items?.[0]?.name || '').trim().toLowerCase();
  const bookedServiceName = String(appointment.serviceName || appointment.items?.[0]?.serviceName || '').trim().toLowerCase();
  if (!bookedServiceName || keptServiceName !== bookedServiceName || duplicateServiceName === bookedServiceName || keptServiceName === duplicateServiceName) {
    throw new Error(`Order pair ${pair.keep}/${pair.duplicate} does not have a unique appointment-matching service variant`);
  }
  if (serviceSignature(kept) !== serviceSignature(duplicate)) {
    throw new Error(`Order pair ${pair.keep}/${pair.duplicate} differs beyond the service name: ${JSON.stringify(findDifferences(serviceComparable(kept), serviceComparable(duplicate)))}`);
  }
  if (Number(kept.createdAt || 0) >= Number(duplicate.createdAt || 0)) throw new Error(`Booked-service order ${pair.keep} is not earlier than its variant`);
  if (Number(kept.createdAt || 0) < from || Number(duplicate.createdAt || 0) >= to) throw new Error(`Order pair ${pair.keep}/${pair.duplicate} is outside Nov 1-6`);
  if (kept.customerId || duplicate.customerId) throw new Error('A duplicate order has a customer account; refusing to alter loyalty totals');
  const hasInventory = [kept, duplicate].some(order => (order.items || []).some((item: any) =>
    item.type === 'product' && item.refId || (item.consumedProducts || []).some((used: any) => used.productId && Number(used.qty || 0) !== 0)));
  if (hasInventory) throw new Error(`Order pair ${pair.keep}/${pair.duplicate} has inventory effects requiring separate reversal`);
}
const payoutReferences = payoutItems.filter(item => allPairIds.includes(String(item.orderId || ''))
  || allPairIds.some(id => String(item.itemKey || '').startsWith(`${id}:`)));
if (payoutReferences.length) throw new Error('A service-variant order has payout history; refusing to void it');

const grossLines = calculateUnpaidStaffEarnings(orders, [], appointments, from, to);
const duplicateLines = grossLines.filter(line => duplicateIds.includes(line.orderId));
const duplicateTotal = duplicateLines.reduce((sum, line) => sum + line.amount, 0);
if (duplicateLines.length !== 4 || duplicateTotal !== 1980) {
  throw new Error(`Refusing correction: found ${duplicateLines.length} duplicate lines / KES ${duplicateTotal}; expected 4 / KES 1,980`);
}
const currentTotal = grossLines.reduce((sum, line) => sum + line.amount, 0);
const projectedTotal = currentTotal - duplicateTotal;
const byStaff = new Map<string, number>();
for (const line of duplicateLines) byStaff.set(line.staffId, (byStaff.get(line.staffId) || 0) + line.amount);
const confirmed = process.argv.includes('--confirm');
if (!confirmed) {
  console.log(JSON.stringify({
    dryRun: true,
    currentEarningsKES: currentTotal,
    duplicateEarningsKES: duplicateTotal,
    projectedEarningsKES: projectedTotal,
    duplicateLines: duplicateLines.map(line => ({ orderId: line.orderId, staffId: line.staffId, role: line.role, service: line.serviceName, amount: line.amount })),
    earningsByStaffId: Object.fromEntries(byStaff),
    payoutReferences: payoutReferences.length,
    ordersToVoid: pairs.map(pair => ({ keepBookedService: pair.keep, voidServiceVariant: pair.duplicate, appointmentId: pair.appointmentId })),
    action: 'No records changed. Pass --confirm to void the two later non-matching service variants.',
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
        summary: `voided duplicate service variant: ${order.customerName || 'Walk-in Customer'}`,
        recordSnapshot: order, reason, createdAt: deletedAt,
      })}::jsonb
    )`;
  }

  const verifiedRows = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${duplicateIds})` as any[];
  const verifiedVoids = verifiedRows.filter(row => row.record?.deletedAt && row.record?.voidReason === reason).length;
  const finalLines = calculateUnpaidStaffEarnings(
    orders.map(order => duplicateIds.includes(String(order.id)) ? { ...order, deletedAt } : order),
    payoutItems, appointments, from, to,
  );
  const finalTotal = finalLines.reduce((sum, line) => sum + line.amount, 0);
  if (verifiedVoids !== duplicateIds.length || finalTotal !== projectedTotal) throw new Error(`Post-correction verification failed: voided=${verifiedVoids}, total=${finalTotal}`);
  console.log(JSON.stringify({
    corrected: true,
    voidedOrderIds: duplicateIds,
    retainedOrderIds: pairs.map(pair => pair.keep),
    removedEarningsKES: duplicateTotal,
    earningsByStaffIdRemoved: Object.fromEntries(byStaff),
    finalEarningsKES: finalTotal,
    reason,
  }, null, 2));
}