import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { staffCommission } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const date = process.argv[2] || '2026-11-07';
const from = Date.parse(`${date}T00:00:00+03:00`);
const to = from + 24 * 60 * 60 * 1000;
const sql = neon(databaseUrl);
const orderRows = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND NOT (record ? 'deletedAt')
    AND (record->>'createdAt')::numeric >= ${from}
    AND (record->>'createdAt')::numeric < ${to}
` as any[];
const orderRecords = orderRows.map(row => ({ ...row.record, id: String(row.id) }))
  .filter(order => !order.branchId || order.branchId === branchId);
const appointmentIds = Array.from(new Set(orderRecords.map(order => String(order.appointmentId || '')).filter(Boolean)));
const appointmentRows = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'appointments'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND (record->>'date' = ${date} OR id = ANY(${appointmentIds}))
` as any[];
const appointments = appointmentRows.map(row => ({ ...row.record, id: String(row.id) }))
  .filter(appointment => !appointment.branchId || appointment.branchId === branchId);
const appointmentsById = new Map(appointments.map(appointment => [String(appointment.id), appointment]));
const todayAppointments = appointments.filter(appointment => appointment.date === date && !appointment.deletedAt);
const completedToday = todayAppointments.filter(appointment => appointment.status === 'completed');
const expenses = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'expenses'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'date' = ${date}
` as any[];
const dayExpenses = expenses.map(row => row.record).filter(expense => !expense.branchId || expense.branchId === branchId);
const appointmentStatuses = Array.from(new Set(todayAppointments.map(item => String(item.status || 'unknown'))));
let revenue = 0;
let staffPayments = 0;
let revenueLinkedToSameDayAppointments = 0;
let staffPaymentsLinkedToSameDayAppointments = 0;
const orderDetails = orderRecords.map(order => {
  const appointment = appointmentsById.get(String(order.appointmentId || ''));
  const orderRevenue = Number(order.totalByCurrency?.KES ?? order.total ?? 0);
  let orderStaffPayments = 0;
  for (const item of order.items || []) {
    if (item.type !== 'service') continue;
    orderStaffPayments += staffCommission(item, item.staffId || appointment?.staffId);
    orderStaffPayments += staffCommission(item, item.coStaffId);
    orderStaffPayments += staffCommission(item, item.thirdStaffId);
    orderStaffPayments += Math.max(0, Number(item.assistantPayment ?? item.helperDeduction ?? 0));
  }
  revenue += orderRevenue;
  staffPayments += orderStaffPayments;
  if (appointment?.date === date && appointment.status === 'completed' && !appointment.deletedAt) {
    revenueLinkedToSameDayAppointments += orderRevenue;
    staffPaymentsLinkedToSameDayAppointments += orderStaffPayments;
  }
  return {
    orderId: String(order.id),
    createdAt: new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
    customer: order.customerName || 'Walk-in Customer',
    revenueKES: orderRevenue,
    staffPaymentsKES: orderStaffPayments,
    appointmentId: appointment?.id || order.appointmentId || null,
    appointmentDate: appointment?.date || null,
    appointmentStatus: appointment?.status || null,
    appointmentDeleted: Boolean(appointment?.deletedAt),
    serviceItems: (order.items || []).filter((item: any) => item.type === 'service').map((item: any) => item.name),
  };
});

console.log(JSON.stringify({
  readOnly: true,
  branch: 'Main Branch',
  date,
  appointmentCounts: {
    all: todayAppointments.length,
    completed: completedToday.length,
    statuses: Object.fromEntries(appointmentStatuses.map(status => [
      status, todayAppointments.filter(item => String(item.status || 'unknown') === status).length,
    ])),
  },
  orderCount: orderRecords.length,
  revenueByOrderCreatedDateKES: revenue,
  staffPaymentsByOrderCreatedDateKES: staffPayments,
  revenueForCompletedSameDayAppointmentsKES: revenueLinkedToSameDayAppointments,
  staffPaymentsForCompletedSameDayAppointmentsKES: staffPaymentsLinkedToSameDayAppointments,
  expensesForDateKES: dayExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
  orders: orderDetails,
}, null, 2));