import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const date = process.argv[2] || '2026-11-06';
const from = Date.parse(`${date}T00:00:00+03:00`);
const to = from + 24 * 60 * 60 * 1000;
const sql = neon(databaseUrl);
const [staffRows, appointmentRows, payoutRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})`,
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'date' = ${date}`,
  sql`SELECT id, record FROM app_records WHERE collection = 'payout_items'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})`,
]);
const records = (rows: any[]) => rows.map(row => ({ ...row.record, id: String(row.id) }));
const staff = records(staffRows);
const staffById = new Map(staff.map(member => [String(member.id), member]));
const appointments = records(appointmentRows).filter(item => !item.branchId || item.branchId === branchId);
const appointmentsById = new Map(appointments.map(item => [String(item.id), item]));
const appointmentIds = new Set(appointments.map(item => String(item.id)));
const orderRows = appointmentIds.size ? await sql`
  SELECT id, record FROM app_records WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'appointmentId' = ANY(${Array.from(appointmentIds)})
` as any[] : [];
const orders = records(orderRows).filter(order => appointmentIds.has(String(order.appointmentId || ''))
  && (!order.branchId || order.branchId === branchId));
const payoutItems = records(payoutRows);
const orderIds = orders.map(order => String(order.id));
const auditRows = orderIds.length ? await sql`
  SELECT record FROM app_records WHERE collection = 'audit_logs'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'recordId' = ANY(${orderIds})
` as any[] : [];
const auditLogs = records(auditRows);
const activeCompleted = appointments.filter(item => item.status === 'completed' && !item.deletedAt);
const activeOrders = orders.filter(order => !order.deletedAt);
const activeOrderIds = new Set(activeOrders.map(order => String(order.id)));
const earningLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, from, to)
  .filter(line => line.currency === 'KES' && !orders.find(order => String(order.id) === line.orderId)?.deletedAt);
const lineKeys = new Set(earningLines.map(line => line.itemKey));
const paidKeys = new Set(payoutItems.filter(item => !item.deletedAt).map(item => String(item.itemKey || '')));
const staffTotals = new Map<string, any>();
for (const member of staff.filter(item => !item.deletedAt && item.employmentStatus !== 'laid-off')) {
  staffTotals.set(String(member.id), {
    staffId: String(member.id), name: member.name, role: member.role,
    commissionKES: 0, assistantKES: 0, unpaidKES: 0, paidKES: 0, lines: 0,
  });
}
for (const line of earningLines) {
  const total = staffTotals.get(line.staffId) || {
    staffId: line.staffId, name: staffById.get(line.staffId)?.name || 'Unknown', role: staffById.get(line.staffId)?.role || '',
    commissionKES: 0, assistantKES: 0, unpaidKES: 0, paidKES: 0, lines: 0,
  };
  total.lines += 1;
  if (line.role === 'assistant') total.assistantKES += line.amount;
  else total.commissionKES += line.amount;
  if (paidKeys.has(line.itemKey)) total.paidKES += line.amount;
  else total.unpaidKES += line.amount;
  staffTotals.set(line.staffId, total);
}
const orderAuditById = new Map<string, any[]>();
for (const log of auditLogs) {
  if (!log.recordId || !['order', 'orders'].includes(String(log.collection || '').toLowerCase())) continue;
  const list = orderAuditById.get(String(log.recordId)) || [];
  list.push({ action: log.action, actor: log.actor, createdAt: log.createdAt, reason: log.reason || null });
  orderAuditById.set(String(log.recordId), list);
}
const appointmentRowsSummary = appointments.map(appointment => {
  const linkedOrders = orders.filter(order => String(order.appointmentId || '') === String(appointment.id));
  const activeForAppointment = linkedOrders.filter(order => !order.deletedAt);
  return {
    id: String(appointment.id), cardNumber: appointment.cardNumber || null, time: appointment.time || null,
    customer: appointment.customerName || null, status: appointment.status, deleted: Boolean(appointment.deletedAt),
    staffName: appointment.staffName || staffById.get(String(appointment.staffId || ''))?.name || null,
    staffId: appointment.staffId || null,
    activeOrderCount: activeForAppointment.length,
    deletedOrderCount: linkedOrders.length - activeForAppointment.length,
    orders: linkedOrders.map(order => ({
      id: String(order.id), deleted: Boolean(order.deletedAt), deletedBy: order.deletedBy || null,
      voidReason: order.voidReason || null,
      createdAtLocal: new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
      revenueKES: Number(order.totalByCurrency?.KES || 0),
      lines: earningLines.filter(line => line.orderId === String(order.id)).map(line => ({
        staffId: line.staffId, staffName: staffById.get(line.staffId)?.name || 'Unknown',
        role: line.role, service: line.serviceName, amountKES: line.amount,
        paid: paidKeys.has(line.itemKey), itemKey: line.itemKey,
      })),
      audit: orderAuditById.get(String(order.id)) || [],
    })),
  };
});
const completedWithoutActiveOrder = appointmentRowsSummary.filter(item => item.status === 'completed' && !item.deleted && item.activeOrderCount === 0);
const multipleActiveOrders = appointmentRowsSummary.filter(item => item.status === 'completed' && !item.deleted && item.activeOrderCount > 1);
const orphanPaidMarkers = payoutItems.filter(item => !item.deletedAt && item.itemKey && !lineKeys.has(String(item.itemKey))
  && orders.some(order => String(item.orderId || '') === String(order.id) || String(item.itemKey).startsWith(`${order.id}:`)))
  .map(item => ({ orderId: item.orderId || null, itemKey: item.itemKey, staffId: item.staffId || null }));
const totals = Array.from(staffTotals.values()).sort((left, right) => left.name.localeCompare(right.name));
console.log(JSON.stringify({
  readOnly: true,
  branch: 'Main Branch', date,
  period: { from: new Date(from).toISOString(), toExclusive: new Date(to).toISOString() },
  counts: {
    appointments: appointments.length,
    activeCompletedAppointments: activeCompleted.length,
    deletedAppointments: appointments.filter(item => item.deletedAt).length,
    linkedOrders: orders.length,
    activeOrders: activeOrders.length,
    deletedOrders: orders.length - activeOrders.length,
    earningLines: earningLines.length,
    staffWithEarnings: totals.filter(item => item.commissionKES + item.assistantKES > 0).length,
  },
  totals: {
    revenueKES: activeOrders.filter(order => activeCompleted.some(item => String(item.id) === String(order.appointmentId)))
      .reduce((sum, order) => sum + Number(order.totalByCurrency?.KES || 0), 0),
    commissionKES: totals.reduce((sum, item) => sum + item.commissionKES, 0),
    assistantKES: totals.reduce((sum, item) => sum + item.assistantKES, 0),
    unpaidKES: totals.reduce((sum, item) => sum + item.unpaidKES, 0),
    paidKES: totals.reduce((sum, item) => sum + item.paidKES, 0),
  },
  staff: totals,
  completedWithoutActiveOrder,
  multipleActiveOrders,
  orphanPaidMarkers,
  appointments: appointmentRowsSummary,
}, null, 2));
