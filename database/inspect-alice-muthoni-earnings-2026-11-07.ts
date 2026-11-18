import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const from = Date.parse('2026-10-31T00:00:00+03:00');
const to = Date.parse('2026-11-07T00:00:00+03:00');
const targets = new Map([
  ['staff-5d93c3a0-5760-4a5c-88ae-073953a0af5e', 9500],
  ['staff-cdb4a578-5c51-477e-9c6d-36c56251999d', 12260],
]);
const sql = neon(databaseUrl);
const load = async (collection: string) => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = ${collection}
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
` as any[];
const [staffRows, appointmentRows, orderRows, payoutRows, auditRows] = await Promise.all([
  load('staff'), load('appointments'), load('orders'), load('payout_items'), load('audit_logs'),
]);
const records = (rows: any[]) => rows.map(row => ({
  ...row.record, id: String(row.id), tenantId: row.record?.tenantId || row.tenant_id,
}));
const staff = records(staffRows).filter(item => targets.has(String(item.id)));
const staffById = new Map(staff.map(item => [String(item.id), item]));
const appointments = records(appointmentRows);
const appointmentsById = new Map(appointments.map(item => [String(item.id), item]));
const allOrders = records(orderRows);
const orders = allOrders.filter(order => {
  if (order.branchId) return order.branchId === branchId;
  const appointment = appointmentsById.get(String(order.appointmentId || ''));
  if (appointment?.branchId) return appointment.branchId === branchId;
  return (order.items || []).some((item: any) => [item.staffId, item.coStaffId, item.thirdStaffId, item.helperStaffId]
    .some(id => staffById.get(String(id || ''))?.branchId === branchId));
});
const allPayouts = records(payoutRows);
const orderIds = new Set(orders.map(order => String(order.id)));
const itemKeys = new Set(orders.flatMap(order => (order.items || []).flatMap((item: any, index: number) => item.type === 'service'
  ? [`${order.id}:${index}`, `${order.id}:${index}:co-staff`, `${order.id}:${index}:third-staff`, `${order.id}:${index}:assistant`]
  : [])));
const payoutItems = allPayouts.filter(item => (!item.branchId || item.branchId === branchId)
  && (orderIds.has(String(item.orderId || '')) || itemKeys.has(String(item.itemKey || ''))));
const activeOrders = orders.filter(order => !order.deletedAt);
const deletedOrders = orders.filter(order => order.deletedAt);
const activePayouts = payoutItems.filter(item => !item.deletedAt);
const grossLines = calculateUnpaidStaffEarnings(activeOrders, [], appointments, from, to)
  .filter(line => targets.has(line.staffId) && line.currency === 'KES');
const unpaidLines = calculateUnpaidStaffEarnings(activeOrders, activePayouts, appointments, from, to)
  .filter(line => targets.has(line.staffId) && line.currency === 'KES');
const deletedLines = calculateUnpaidStaffEarnings(deletedOrders.map(order => {
  const restored = { ...order };
  delete restored.deletedAt;
  delete restored.deletedBy;
  delete restored.voidReason;
  delete restored.deletionReason;
  delete restored.payoutReversalRequired;
  return restored;
}), [], appointments, from, to).filter(line => targets.has(line.staffId) && line.currency === 'KES');
const lineDetails = (lines: any[], source: 'active-gross' | 'active-unpaid' | 'soft-deleted') => lines.map(line => {
  const order = allOrders.find(item => String(item.id) === line.orderId);
  const appointment = appointmentsById.get(String(order?.appointmentId || ''));
  const index = Number(line.itemKey.slice(line.orderId.length + 1).split(':')[0]);
  return {
    source,
    staff: staffById.get(line.staffId)?.name || line.staffId,
    earningKES: line.amount,
    itemKey: line.itemKey,
    orderId: line.orderId,
    orderDeletedAt: order?.deletedAt || null,
    deletionReason: order?.voidReason || order?.deletionReason || null,
    orderCreatedAt: order?.createdAt || null,
    paymentMethod: order?.paymentMethod || null,
    appointmentId: appointment?.id || order?.appointmentId || null,
    appointmentDate: appointment?.date || null,
    appointmentStatus: appointment?.status || null,
    cardNumber: appointment?.cardNumber || null,
    service: order?.items?.[index]?.name || line.serviceName,
    role: line.role,
    payoutMarkerActive: activePayouts.some(item => String(item.itemKey || '') === line.itemKey),
  };
});
const totals = Array.from(targets.entries()).map(([staffId, targetKES]) => {
  const member = staffById.get(staffId);
  const sum = (lines: any[]) => lines.filter(line => line.staffId === staffId).reduce((total, line) => total + line.amount, 0);
  return {
    staffId,
    staffName: member?.name || 'Missing staff record',
    targetKES,
    activeGrossKES: sum(grossLines),
    activeUnpaidKES: sum(unpaidLines),
    auditedSoftDeletedKES: sum(deletedLines),
    gapToTargetKES: targetKES - sum(unpaidLines),
  };
});
const relevantSnapshots = records(auditRows).flatMap(audit => {
  const snapshot = audit.recordSnapshot;
  if (!snapshot) return [];
  const order = { ...snapshot, id: String(audit.recordId || snapshot.id || '') };
  const snapshotLines = calculateUnpaidStaffEarnings([order], [], appointments, from, to)
    .filter(line => targets.has(line.staffId) && line.currency === 'KES');
  return snapshotLines.map(line => ({
    action: audit.action, auditAt: audit.createdAt, reason: audit.reason || audit.summary || null,
    ...lineDetails([line], 'soft-deleted')[0],
  }));
});
console.log(JSON.stringify({
  readOnly: true,
  period: { from: '2026-10-31', through: '2026-11-06', timezone: 'Africa/Nairobi' },
  totals,
  activeEarningLines: lineDetails(unpaidLines, 'active-unpaid'),
  softDeletedEarningLines: lineDetails(deletedLines, 'soft-deleted'),
  auditSnapshotLines: relevantSnapshots,
}, null, 2));
