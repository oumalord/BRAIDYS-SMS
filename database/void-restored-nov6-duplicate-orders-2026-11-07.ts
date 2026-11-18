import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const from = Date.parse('2026-11-06T00:00:00+03:00');
const to = Date.parse('2026-11-07T00:00:00+03:00');
const pairs = [
  { keepId: '511de818-8187-40a0-9ba5-fa488190a30f', duplicateId: '30fa04e4-88b2-45ca-a538-4a4653a615f6', appointmentId: '928d0467-0b06-4536-a548-78960e6bb4cb', cardNumber: '9' },
  { keepId: '5865abae-844d-44c0-ac63-c292fcf234ea', duplicateId: '7a2cef9c-7abe-4883-8336-167cc34d7aa7', appointmentId: '8b779054-3a9d-46b2-bbca-12335bb91783', cardNumber: '24' },
  { keepId: '2235138d-e52b-4ddb-92ac-5e093c472763', duplicateId: '163db93a-c80e-4284-b816-29be1812a815', appointmentId: '4c9beb7e-21df-48c0-99b6-5a23557bfb81', cardNumber: '27' },
];
const allOrderIds = pairs.flatMap(pair => [pair.keepId, pair.duplicateId]);
const appointmentIds = pairs.map(pair => pair.appointmentId);
const sql = neon(databaseUrl);
const [orderRows, appointmentRows, dayAppointmentRows, payoutRows, auditRows, staffRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId}) AND id = ANY(${allOrderIds})` as any[],
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId}) AND id = ANY(${appointmentIds})` as any[],
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId}) AND record->>'date' = '2026-11-06'` as any[],
  sql`SELECT id, record FROM app_records WHERE collection = 'payout_items'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})` as any[],
  sql`SELECT record FROM app_records WHERE collection = 'audit_logs'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'recordId' = ANY(${allOrderIds})` as any[],
  sql`SELECT id, record FROM app_records WHERE collection = 'staff'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})` as any[],
]);
const records = (rows: any[]) => rows.map(row => ({ ...row.record, id: String(row.id) }));
const orders = records(orderRows);
const appointments = records(appointmentRows);
const dayAppointments = records(dayAppointmentRows).filter(item => !item.branchId || item.branchId === branchId);
const dayAppointmentIds = dayAppointments.map(item => String(item.id));
const dayOrderRows = dayAppointmentIds.length ? await sql`
  SELECT id, record FROM app_records WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'appointmentId' = ANY(${dayAppointmentIds})
` as any[] : [];
const dayOrders = records(dayOrderRows).filter(order => !order.branchId || order.branchId === branchId);
const payoutItems = records(payoutRows);
const audits = records(auditRows);
const staffById = new Map(records(staffRows).map(member => [String(member.id), member]));
const orderById = new Map(orders.map(order => [String(order.id), order]));
const appointmentById = new Map(appointments.map(item => [String(item.id), item]));
const normalize = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const stableStringify = (value: any): string => Array.isArray(value)
  ? `[${value.map(stableStringify).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const signature = (order: any) => stableStringify({
  appointmentId: order.appointmentId || null,
  customerId: order.customerId || null,
  customerName: normalize(order.customerName),
  branchId: order.branchId || null,
  paymentMethod: order.paymentMethod || null,
  mpesaReceiptNumber: order.mpesaReceiptNumber || null,
  totalByCurrency: order.totalByCurrency || {},
  items: order.items || [],
});
const targets: any[] = [];
for (const pair of pairs) {
  const keep = orderById.get(pair.keepId);
  const duplicate = orderById.get(pair.duplicateId);
  const appointment = appointmentById.get(pair.appointmentId);
  if (!keep || !duplicate || keep.deletedAt || duplicate.deletedAt) throw new Error(`Expected active Card ${pair.cardNumber} order pair was not found.`);
  if (!appointment || appointment.deletedAt || appointment.status !== 'completed' || appointment.date !== '2026-11-06'
    || String(appointment.cardNumber || '') !== pair.cardNumber || keep.appointmentId !== pair.appointmentId || duplicate.appointmentId !== pair.appointmentId) {
    throw new Error(`Card ${pair.cardNumber} appointment/order linkage no longer matches the audit.`);
  }
  if (Number(keep.createdAt || 0) >= Number(duplicate.createdAt || 0) || signature(keep) !== signature(duplicate)) {
    throw new Error(`Card ${pair.cardNumber} orders are not an exact chronological duplicate pair.`);
  }
  if (keep.customerId || duplicate.customerId) throw new Error(`Card ${pair.cardNumber} duplicate has a customer balance.`);
  const hasInventory = [keep, duplicate].some(order => (order.items || []).some((item: any) => item.type === 'product' && item.refId
    || (item.consumedProducts || []).some((used: any) => used.productId && Number(used.qty || 0) !== 0)));
  if (hasInventory) throw new Error(`Card ${pair.cardNumber} duplicate has inventory effects.`);
  const activePayout = payoutItems.some(item => !item.deletedAt && (String(item.orderId || '') === pair.duplicateId
    || String(item.itemKey || '').startsWith(`${pair.duplicateId}:`)));
  if (activePayout) throw new Error(`Card ${pair.cardNumber} duplicate has an active paid marker.`);
  const priorVoidAudit = audits.some(log => String(log.recordId || '') === pair.duplicateId
    && log.action === 'voided duplicate order' && log.recordSnapshot
    && /duplicate/i.test(String(log.reason || '')));
  if (!priorVoidAudit) throw new Error(`Card ${pair.cardNumber} duplicate lacks its original owner audit snapshot.`);
  targets.push({ ...pair, keep, duplicate, appointment });
}
const duplicateIds = new Set(targets.map(target => target.duplicateId));
const ordersBefore = dayOrders;
const ordersAfter = dayOrders.filter(order => !duplicateIds.has(String(order.id)));
const currentLines = calculateUnpaidStaffEarnings(ordersBefore, payoutItems, dayAppointments, from, to)
  .filter(line => line.currency === 'KES');
const projectedLines = calculateUnpaidStaffEarnings(ordersAfter, payoutItems, dayAppointments, from, to)
  .filter(line => line.currency === 'KES');
const sum = (lines: any[]) => lines.reduce((total, line) => total + line.amount, 0);
const currentStaffTotals = new Map<string, number>();
for (const line of currentLines) currentStaffTotals.set(line.staffId, (currentStaffTotals.get(line.staffId) || 0) + line.amount);
const projectedStaffTotals = new Map<string, number>();
for (const line of projectedLines) projectedStaffTotals.set(line.staffId, (projectedStaffTotals.get(line.staffId) || 0) + line.amount);
const duplicateLines = currentLines.filter(line => duplicateIds.has(line.orderId));
const projectedTotal = sum(projectedLines);
const excludedTotal = sum(duplicateLines);
if (currentLines.length !== 122 || projectedLines.length !== 111 || Math.abs(excludedTotal - 3705) > 0.000001
  || Math.abs(projectedTotal - (sum(currentLines) - 3705)) > 0.000001) {
  throw new Error(`Unexpected Nov 6 reconciliation: lines=${currentLines.length}/${projectedLines.length}, excluded=${excludedTotal}, projected=${projectedTotal}.`);
}
const summary = {
  date: '2026-11-06',
  completedAppointments: 32,
  activeOrdersBefore: ordersBefore.filter(order => !order.deletedAt).length,
  activeOrdersAfter: ordersAfter.filter(order => !order.deletedAt).length,
  currentStaffEarningsKES: sum(currentLines),
  duplicateEarningsKES: excludedTotal,
  correctedStaffEarningsKES: projectedTotal,
  duplicateOrders: targets.map(({ cardNumber, keepId, duplicateId, appointment }) => ({
    cardNumber, customer: appointment.customerName, keepOrderId: keepId, duplicateOrderId: duplicateId,
  })),
  staffTotalsBefore: Array.from(currentStaffTotals.entries()).map(([staffId, amount]) => ({ name: staffById.get(staffId)?.name || staffId, amountKES: amount }))
    .sort((left, right) => left.name.localeCompare(right.name)),
  staffTotalsAfter: Array.from(projectedStaffTotals.entries()).map(([staffId, amount]) => ({ name: staffById.get(staffId)?.name || staffId, amountKES: amount }))
    .sort((left, right) => left.name.localeCompare(right.name)),
};

if (!process.argv.includes('--confirm')) {
  console.log(JSON.stringify({ dryRun: true, ...summary, action: 'No records changed. Pass --confirm to soft-delete only these three audited duplicate orders.' }, null, 2));
} else {
  const now = Date.now();
  const reason = 'Owner requested accurate Nov 6 staff earnings; this later exact duplicate sale is excluded and the earliest order is retained.';
  const auditId = randomUUID();
  const auditRecord = {
    id: auditId, tenantId, branchId, actor: 'owner', action: 're-voided restored Nov 6 duplicate orders',
    collection: 'audit_restore', recordId: null,
    summary: 'Excluded three exact duplicate orders reactivated by the Nov 7 restore, retaining the earliest order for each appointment.',
    duplicateOrderIds: Array.from(duplicateIds), expectedEarningsKES: excludedTotal, correctedEarningsKES: projectedTotal, createdAt: now,
  };
  const ids = Array.from(duplicateIds);
  const results = await sql.transaction(txn => [
    txn`UPDATE app_records SET record = record || jsonb_build_object(
        'deletedAt', ${now}::bigint, 'deletedBy', 'owner', 'voidReason', ${reason}::text
      )
      WHERE collection = 'orders' AND id = ANY(${ids}) AND NOT (record ? 'deletedAt')
      RETURNING id`,
    txn`INSERT INTO app_records (id, collection, tenant_id, record)
      VALUES (${auditId}, 'audit_logs', ${tenantId}, ${JSON.stringify(auditRecord)}::jsonb)
      RETURNING id`,
  ]);
  if (results[0].length !== ids.length || results[1].length !== 1) throw new Error('Duplicate correction row-count check failed; transaction rolled back.');
  console.log(JSON.stringify({ corrected: true, ...summary, auditId }, null, 2));
}
