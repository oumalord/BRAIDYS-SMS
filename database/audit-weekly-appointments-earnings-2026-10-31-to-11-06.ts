import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const fromDate = '2026-10-31';
const throughDate = '2026-11-06';
const from = Date.parse(`${fromDate}T00:00:00+03:00`);
const to = Date.parse('2026-11-07T00:00:00+03:00');
const sql = neon(databaseUrl);
const [staffRows, appointmentRows, payoutRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})`,
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'date' >= ${fromDate} AND record->>'date' <= ${throughDate}`,
  sql`SELECT id, record FROM app_records WHERE collection = 'payout_items'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})`,
]);
const records = (rows: any[]) => rows.map(row => ({ ...row.record, id: String(row.id) }));
const staff = records(staffRows).filter(item => !item.deletedAt && item.employmentStatus !== 'laid-off'
  && (!item.branchId || item.branchId === branchId));
const staffById = new Map(staff.map(item => [String(item.id), item]));
const appointments = records(appointmentRows).filter(item => !item.branchId || item.branchId === branchId);
const appointmentById = new Map(appointments.map(item => [String(item.id), item]));
const appointmentIds = appointments.map(item => String(item.id));
const orderRows = await sql`
  SELECT id, record FROM app_records WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND (
      ((record->>'createdAt')::numeric >= ${from} AND (record->>'createdAt')::numeric < ${to})
      OR record->>'appointmentId' = ANY(${appointmentIds})
    )
` as any[];
const orders = records(orderRows).filter(order => {
  if (order.branchId) return order.branchId === branchId;
  const appointment = appointmentById.get(String(order.appointmentId || ''));
  if (appointment?.branchId) return appointment.branchId === branchId;
  return (order.items || []).some((item: any) => [item.staffId, item.coStaffId, item.thirdStaffId, item.helperStaffId]
    .some(id => staffById.get(String(id || ''))?.branchId === branchId));
});
const orderIds = new Set(orders.map(order => String(order.id)));
const earningKeys = orders.flatMap(order => (order.items || []).flatMap((item: any, index: number) => item.type === 'service'
  ? [`${order.id}:${index}`, `${order.id}:${index}:co-staff`, `${order.id}:${index}:third-staff`, `${order.id}:${index}:assistant`]
  : []));
const payoutItems = records(payoutRows).filter(item => !item.branchId || item.branchId === branchId)
  .filter(item => orderIds.has(String(item.orderId || '')) || earningKeys.includes(String(item.itemKey || '')));
const grossLines = calculateUnpaidStaffEarnings(orders, [], appointments, from, to)
  .filter(line => line.currency === 'KES' && staffById.has(line.staffId));
const unpaidLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, from, to)
  .filter(line => line.currency === 'KES' && staffById.has(line.staffId));
const paidKeys = new Set(payoutItems.filter(item => !item.deletedAt).map(item => String(item.itemKey || '')));
const totalsByStaff = new Map<string, any>();
for (const member of staff) totalsByStaff.set(String(member.id), {
  staffId: String(member.id), name: member.name, role: member.role,
  commissionKES: 0, assistantKES: 0, paidKES: 0, unpaidKES: 0, lines: 0,
});
for (const line of grossLines) {
  const total = totalsByStaff.get(line.staffId);
  total.lines += 1;
  if (line.role === 'assistant') total.assistantKES += line.amount;
  else total.commissionKES += line.amount;
  if (paidKeys.has(line.itemKey)) total.paidKES += line.amount;
  if (unpaidLines.some(unpaid => unpaid.itemKey === line.itemKey)) total.unpaidKES += line.amount;
}
const orderLinesById = new Map<string, any[]>();
for (const line of grossLines) {
  const rows = orderLinesById.get(line.orderId) || [];
  rows.push(line);
  orderLinesById.set(line.orderId, rows);
}
const appointmentSummaries = appointments.map(appointment => {
  const linkedOrders = orders.filter(order => String(order.appointmentId || '') === String(appointment.id));
  return {
    id: String(appointment.id), date: appointment.date, time: appointment.time,
    cardNumber: appointment.cardNumber || null, customer: appointment.customerName || null,
    status: appointment.status, deleted: Boolean(appointment.deletedAt),
    staff: appointment.staffName || staffById.get(String(appointment.staffId || ''))?.name || null,
    orders: linkedOrders.map(order => ({
      id: String(order.id), deleted: Boolean(order.deletedAt), voidReason: order.voidReason || null,
      createdAtLocal: new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
      revenueKES: Number(order.totalByCurrency?.KES || 0),
      lines: (orderLinesById.get(String(order.id)) || []).map(line => ({
        staffName: staffById.get(line.staffId)?.name || line.staffId, role: line.role,
        amountKES: line.amount, itemKey: line.itemKey, paid: paidKeys.has(line.itemKey),
      })),
    })),
  };
});
const softDeletedOrders = orders.filter(order => order.deletedAt).map(order => ({
  id: String(order.id), appointmentId: order.appointmentId || null,
  createdAtLocal: new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
  voidReason: order.voidReason || null,
  lines: (order.items || []).flatMap((item: any, index: number) => calculateUnpaidStaffEarnings([{ ...order, deletedAt: undefined }], [], appointments, from, to)
    .filter(line => line.itemKey.startsWith(`${order.id}:${index}`)).map(line => ({ staffName: staffById.get(line.staffId)?.name || line.staffId, role: line.role, amountKES: line.amount }))),
}));
const staffTotals = Array.from(totalsByStaff.values()).filter(item => item.lines)
  .sort((left, right) => left.name.localeCompare(right.name));
console.log(JSON.stringify({
  readOnly: true, branch: 'Main Branch', period: { from: fromDate, through: throughDate },
  totals: {
    appointments: appointments.filter(item => item.status === 'completed' && !item.deletedAt).length,
    grossOrders: orders.filter(item => !item.deletedAt).length,
    grossLines: grossLines.length,
    paidKES: grossLines.filter(line => paidKeys.has(line.itemKey)).reduce((sum, line) => sum + line.amount, 0),
    unpaidKES: unpaidLines.reduce((sum, line) => sum + line.amount, 0),
    grossKES: grossLines.reduce((sum, line) => sum + line.amount, 0),
    softDeletedOrders: softDeletedOrders.length,
  },
  staff: staffTotals,
  targetStaff: staffTotals.filter(item => /^(Salma|Brenda)$/i.test(String(item.name))),
  softDeletedOrders,
  appointments: appointmentSummaries,
}, null, 2));
