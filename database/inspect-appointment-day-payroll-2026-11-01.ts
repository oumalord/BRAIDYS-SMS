import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const appointmentDate = process.argv[2] || '2026-11-01';
const dayStart = Date.parse(`${appointmentDate}T00:00:00+03:00`);
const localNoon = new Date(`${appointmentDate}T12:00:00+03:00`);
const daysSinceSaturday = (localNoon.getUTCDay() + 1) % 7;
const payrollFrom = dayStart - daysSinceSaturday * 24 * 60 * 60 * 1000;
const payrollTo = payrollFrom + 7 * 24 * 60 * 60 * 1000;
const sql = neon(databaseUrl);
const appointmentRows = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'appointments'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'date' = ${appointmentDate}
` as any[];
const appointments = appointmentRows.map(row => ({ ...row.record, id: String(row.id) }))
  .filter(appointment => !appointment.branchId || appointment.branchId === branchId);
const appointmentIds = appointments.map(appointment => String(appointment.id));
const orderRows = appointmentIds.length ? await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'appointmentId' = ANY(${appointmentIds})
` as any[] : [];
const orders = orderRows.map(row => ({ ...row.record, id: String(row.id) }))
  .filter(order => !order.branchId || order.branchId === branchId);
const orderIds = orders.map(order => String(order.id));
const earningKeys = orders.flatMap(order => (order.items || []).flatMap((item: any, index: number) => item.type === 'service'
  ? [`${order.id}:${index}`, `${order.id}:${index}:co-staff`, `${order.id}:${index}:third-staff`, `${order.id}:${index}:assistant`]
  : []));
const payoutRows = earningKeys.length ? await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'payout_items'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'itemKey' = ANY(${earningKeys})
` as any[] : [];
const payoutItems = payoutRows.map(row => ({ ...row.record, id: String(row.id) }));
const allLines = calculateUnpaidStaffEarnings(orders, [], appointments, payrollFrom, payrollTo);
const unpaidLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, payrollFrom, payrollTo);
const linesByAppointment = new Map<string, any[]>();
for (const line of unpaidLines) {
  const order = orders.find(item => String(item.id) === line.orderId);
  const key = String(order?.appointmentId || '');
  const rows = linesByAppointment.get(key) || [];
  rows.push(line);
  linesByAppointment.set(key, rows);
}
const totalsByStaff = new Map<string, number>();
for (const line of unpaidLines.filter(item => item.currency === 'KES')) {
  totalsByStaff.set(line.staffId, (totalsByStaff.get(line.staffId) || 0) + line.amount);
}
const appointmentsById = new Map(appointments.map(item => [String(item.id), item]));
const completedAppointmentIds = new Set(appointments.filter(item => item.date === appointmentDate && item.status === 'completed' && !item.deletedAt).map(item => String(item.id)));
const ordersByAppointment = new Map<string, any[]>();
for (const order of orders) {
  const key = String(order.appointmentId || '');
  const rows = ordersByAppointment.get(key) || [];
  rows.push(order);
  ordersByAppointment.set(key, rows);
}
const completedAppointmentOrders = orders.filter(order => !order.deletedAt && completedAppointmentIds.has(String(order.appointmentId || '')));
const dailyRevenueKES = completedAppointmentOrders.reduce((sum, order) => sum + Number(order.totalByCurrency?.KES ?? order.total ?? 0), 0);
const allAppointmentDateLines = calculateUnpaidStaffEarnings(orders, [], appointments, 0, Date.now() + 1)
  .filter(line => line.currency === 'KES' && completedAppointmentIds.has(String(orders.find(order => String(order.id) === line.orderId)?.appointmentId || '')));
const dailyStaffPaymentsKES = allAppointmentDateLines.reduce((sum, line) => sum + line.amount, 0);
const statusCounts = Object.fromEntries(Array.from(new Set(appointments.map(item => String(item.status || 'unknown'))))
  .map(status => [status, appointments.filter(item => String(item.status || 'unknown') === status).length]));
console.log(JSON.stringify({
  readOnly: true,
  branch: 'Main Branch',
  appointmentDate,
  payrollWindow: {
    from: new Date(payrollFrom).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
    through: new Date(payrollTo - 1).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
    timezone: 'Africa/Nairobi',
  },
  appointmentCounts: {
    total: appointments.length,
    deleted: appointments.filter(item => item.deletedAt).length,
    statuses: statusCounts,
  },
  linkedOrders: orders.length,
  activeLinkedOrders: orders.filter(order => !order.deletedAt).length,
  completedSameDayAppointmentCount: completedAppointmentIds.size,
  completedSameDayAppointmentOrderCount: completedAppointmentOrders.length,
  revenueByCompletedAppointmentDateKES: dailyRevenueKES,
  staffPaymentsByCompletedAppointmentDateKES: dailyStaffPaymentsKES,
  dailyEarningsByStaffId: Object.fromEntries(Array.from(allAppointmentDateLines.reduce((map, line) => {
    map.set(line.staffId, (map.get(line.staffId) || 0) + line.amount);
    return map;
  }, new Map<string, number>()))),
  softDeletedLinkedOrders: orders.filter(order => order.deletedAt).map(order => ({
    orderId: String(order.id), appointmentId: String(order.appointmentId),
    deletedAt: order.deletedAt, deletedBy: order.deletedBy || null, voidReason: order.voidReason || null,
  })),
  grossEarningLinesInPayrollWindow: allLines.length,
  unpaidEarningLinesInPayrollWindow: unpaidLines.length,
  grossEarningsKES: allLines.filter(line => line.currency === 'KES').reduce((sum, line) => sum + line.amount, 0),
  unpaidEarningsKES: unpaidLines.filter(line => line.currency === 'KES').reduce((sum, line) => sum + line.amount, 0),
  unpaidByStaffId: Object.fromEntries(totalsByStaff),
  appointments: appointments.map(appointment => ({
    id: String(appointment.id),
    cardNumber: appointment.cardNumber || null,
    customer: appointment.customerName || null,
    status: appointment.status || null,
    deletedAt: appointment.deletedAt || null,
    staffName: appointment.staffName || null,
    orderCount: (ordersByAppointment.get(String(appointment.id)) || []).length,
    orders: (ordersByAppointment.get(String(appointment.id)) || []).map(order => ({
      id: String(order.id),
      createdAt: new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
      deletedAt: order.deletedAt || null,
      voidReason: order.voidReason || null,
      earningsKES: (linesByAppointment.get(String(appointment.id)) || []).filter(line => line.orderId === String(order.id) && line.currency === 'KES').reduce((sum, line) => sum + line.amount, 0),
      payoutKeys: payoutItems.filter(item => String(item.orderId || '') === String(order.id) && !item.deletedAt).map(item => String(item.itemKey || '')),
    })),
  })),
}, null, 2));