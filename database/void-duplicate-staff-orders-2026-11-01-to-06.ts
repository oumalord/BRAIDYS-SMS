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
  { keep: 'df55a326-29f8-454c-933c-95c2ab2cd7a2', duplicate: '8a142b05-6fff-4f4c-803c-c9c08a5e8bbe', appointmentId: 'c7a02c5f-3456-4c86-bd7c-d43f4184e7f4' },
  { keep: '102a3843-d138-4a15-8c59-34bd1e4f63b8', duplicate: '26328327-b007-4fc6-82d1-ebe09e64f11e', appointmentId: 'd7cb3927-448a-4324-87b7-dd59fb63c601' },
  { keep: '041855b6-2cf1-4b1e-a7eb-97f5443981c9', duplicate: 'd7779ae2-a44c-4003-8a19-fffc016bbcdf', appointmentId: '25eeaea6-f7e5-4d94-a5ad-53644c0349da' },
  { keep: '322354d9-942c-4f8a-8421-de20dc5b95b8', duplicate: '722aed9a-4889-47f2-91c2-18f6387bff75', appointmentId: '0da122f8-28b5-40aa-a304-defedc4098aa' },
];
const duplicateIds = pairs.map(pair => pair.duplicate);
const reason = 'Owner requested removal of exact duplicate orders from the Nov 1-6 staff earnings audit; earliest matching order retained.';
const sql = neon(databaseUrl);
if (process.argv.includes('--status')) {
  const [statusRows, auditRows] = await Promise.all([
    sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${duplicateIds})`,
    sql`SELECT record FROM app_records WHERE collection = 'audit_logs' AND record->>'recordId' = ANY(${duplicateIds}) AND record->>'action' = 'voided duplicate order'`,
  ]) as any[][];
  console.log(JSON.stringify({
    orders: statusRows.map(row => ({ id: String(row.id), deletedAt: row.record?.deletedAt || null, deletedBy: row.record?.deletedBy || null, voidReason: row.record?.voidReason || null })),
    auditEntries: auditRows.length,
  }, null, 2));
  process.exit(0);
}
const loadRows = async (collection: string) => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = ${collection}
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
` as any[];
const relevantOrderIds = pairs.flatMap(pair => [pair.keep, pair.duplicate]);
const loadWindowOrders = async () => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND (
      id = ANY(${relevantOrderIds})
      OR (
        NOT (record ? 'deletedAt')
        AND (record->>'createdAt')::numeric >= ${from}
        AND (record->>'createdAt')::numeric < ${to}
      )
    )
` as any[];
const [orderRows, appointmentRows, payoutRows] = await Promise.all([
  loadWindowOrders(), loadRows('appointments'), loadRows('payout_items'),
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
const normalize = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
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
    customerName: normalize(order.customerName),
    branchId: order.branchId || appointment?.branchId || null,
    paymentMethod: order.paymentMethod || null,
    mpesaReceiptNumber: order.mpesaReceiptNumber || null,
    totalByCurrency: order.totalByCurrency || {},
    items: order.items || [],
  });
};

for (const pair of pairs) {
  const kept = ordersById.get(pair.keep);
  const duplicate = ordersById.get(pair.duplicate);
  const appointment = appointmentsById.get(pair.appointmentId);
  if (!kept || !duplicate || kept.deletedAt || duplicate.deletedAt) throw new Error(`Expected active pair ${pair.keep}/${pair.duplicate} was not found`);
  if (!appointment || appointment.deletedAt || String(appointment.id) !== String(kept.appointmentId)
    || kept.appointmentId !== pair.appointmentId || duplicate.appointmentId !== pair.appointmentId) {
    throw new Error(`Orders ${pair.keep}/${pair.duplicate} do not share the expected active appointment`);
  }
  if (signature(kept) !== signature(duplicate)) throw new Error(`Orders ${pair.keep}/${pair.duplicate} are not exact matches`);
  if (Number(kept.createdAt || 0) >= Number(duplicate.createdAt || 0)) throw new Error(`Order ${pair.keep} is not the earlier order`);
  if (Number(kept.createdAt || 0) < from || Number(kept.createdAt || 0) >= to
    || Number(duplicate.createdAt || 0) < from || Number(duplicate.createdAt || 0) >= to) {
    throw new Error(`Order pair ${pair.keep}/${pair.duplicate} is outside the audited earning window`);
  }
  if (kept.customerId || duplicate.customerId) throw new Error('A duplicate order has a customer account; refusing a partial customer-balance correction');
  const hasInventory = [kept, duplicate].some(order => (order.items || []).some((item: any) =>
    item.type === 'product' && item.refId || (item.consumedProducts || []).some((used: any) => used.productId && Number(used.qty || 0) !== 0)));
  if (hasInventory) throw new Error(`Order pair ${pair.keep}/${pair.duplicate} has inventory effects requiring a separate reversal`);
}

const payoutReferences = payoutItems.filter(item => duplicateIds.includes(String(item.orderId || ''))
  || duplicateIds.some(id => String(item.itemKey || '').startsWith(`${id}:`)));
if (payoutReferences.length) throw new Error('At least one duplicate order has payout history; refusing to void it');

const grossLines = calculateUnpaidStaffEarnings(orders, [], appointments, from, to);
const unpaidLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, from, to);
const duplicateLines = grossLines.filter(line => duplicateIds.includes(line.orderId));
const currentTotal = grossLines.reduce((sum, line) => sum + line.amount, 0);
const duplicateTotal = duplicateLines.reduce((sum, line) => sum + line.amount, 0);
const projectedTotal = grossLines.filter(line => !duplicateIds.includes(line.orderId)).reduce((sum, line) => sum + line.amount, 0);
const activePaidKeys = new Set(payoutItems.filter(item => !item.deletedAt).map(item => String(item.itemKey || '')));
if (currentTotal !== 246119.525 || duplicateTotal !== 4710 || projectedTotal !== 241409.525
  || grossLines.length !== 575 || duplicateLines.length !== 11
  || unpaidLines.length !== grossLines.length || activePaidKeys.size > 0) {
  throw new Error(`Refusing correction: gross=${currentTotal}, duplicate=${duplicateTotal}, projected=${projectedTotal}, lines=${grossLines.length}/${duplicateLines.length}, unpaid=${unpaidLines.length}; expected 246119.525/4710/241409.525 and 575/11/575.`);
}

const byStaff = new Map<string, number>();
for (const line of duplicateLines) byStaff.set(line.staffId, (byStaff.get(line.staffId) || 0) + line.amount);
const confirmation = process.argv.includes('--confirm');
if (!confirmation) {
  console.log(JSON.stringify({
    dryRun: true,
    period: { from: '2026-11-01', through: '2026-11-06', timezone: 'Africa/Nairobi' },
    currentGrossAndUnpaidKES: currentTotal,
    duplicateEarningsKES: duplicateTotal,
    projectedGrossAndUnpaidKES: projectedTotal,
    currentLines: grossLines.length,
    duplicateLines: duplicateLines.length,
    projectedLines: grossLines.length - duplicateLines.length,
    payoutReferences: payoutReferences.length,
    duplicateOrders: pairs.map(pair => ({ keep: pair.keep, void: pair.duplicate, appointmentId: pair.appointmentId })),
    duplicateEarningsByStaffId: Object.fromEntries(byStaff),
    action: 'No records changed. Pass --confirm to soft-delete the four later duplicate orders.',
  }, null, 2));
} else {
  const deletedAt = Date.now();
  const voidedRows = await sql`
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
  if (voidedRows.length !== duplicateIds.length) throw new Error(`Expected to void ${duplicateIds.length} orders, voided ${voidedRows.length}`);

  for (const id of duplicateIds) {
    const auditId = randomUUID();
    const order = ordersById.get(id)!;
    await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (
      ${auditId}, 'audit_logs', ${tenantId}, ${JSON.stringify({
        id: auditId,
        tenantId,
        branchId: order.branchId || null,
        action: 'voided duplicate order',
        collection: 'order',
        actor: 'owner',
        recordId: id,
        summary: `voided duplicate order: ${order.customerName || 'Walk-in Customer'}`,
        recordSnapshot: order,
        reason,
        createdAt: deletedAt,
      })}::jsonb
    )`;
  }

  const updatedRows = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${duplicateIds})` as any[];
  const verifiedVoids = updatedRows.filter(row => row.record?.deletedAt && row.record?.voidReason === reason).length;
  const refreshedOrders = records(await loadWindowOrders());
  const finalLines = calculateUnpaidStaffEarnings(refreshedOrders, payoutItems, appointments, from, to);
  const finalTotal = finalLines.reduce((sum, line) => sum + line.amount, 0);
  if (verifiedVoids !== duplicateIds.length || finalTotal !== projectedTotal || finalLines.length !== grossLines.length - duplicateLines.length) {
    throw new Error(`Post-correction verification failed: voided=${verifiedVoids}, total=${finalTotal}, lines=${finalLines.length}`);
  }
  console.log(JSON.stringify({
    corrected: true,
    voidedOrderIds: duplicateIds,
    retainedOrderIds: pairs.map(pair => pair.keep),
    removedEarningsKES: duplicateTotal,
    earningsByStaffIdRemoved: Object.fromEntries(byStaff),
    finalUnpaidKES: finalTotal,
    finalLineCount: finalLines.length,
    reason,
  }, null, 2));
}