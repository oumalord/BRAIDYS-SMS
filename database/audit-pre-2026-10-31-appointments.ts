import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const cutoffDate = '2026-10-31';
const payrollFrom = Date.parse('2026-10-31T00:00:00+03:00');
const payrollTo = Date.parse('2026-11-07T00:00:00+03:00');
const sql = neon(databaseUrl);
const appointmentRows = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'appointments'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'date' < ${cutoffDate}
    AND (record->>'branchId' = ${branchId} OR record->>'branchId' IS NULL OR record->>'branchId' = '')
` as any[];
const records = (rows: any[]) => rows.map(row => ({ ...row.record, id: String(row.id), tenantId: row.record?.tenantId || row.tenant_id }));
const allAppointments = records(appointmentRows);
const targetAppointments = allAppointments;
const targetAppointmentIds = new Set(targetAppointments.map(item => String(item.id)));
const appointmentIdList = Array.from(targetAppointmentIds);
const orderRows = appointmentIdList.length ? await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'appointmentId' = ANY(${appointmentIdList})
` as any[] : [];
const allOrders = records(orderRows);
const targetOrders = allOrders.filter(order => targetAppointmentIds.has(String(order.appointmentId || ''))
  && (!order.branchId || order.branchId === branchId));
const activeOrders = targetOrders.filter(order => !order.deletedAt);
const targetOrderIds = Array.from(new Set(targetOrders.map(order => String(order.id))));
const targetEarningKeys = targetOrders.flatMap(order => (order.items || []).flatMap((item: any, index: number) => item.type === 'service'
  ? [`${order.id}:${index}`, `${order.id}:${index}:co-staff`, `${order.id}:${index}:third-staff`, `${order.id}:${index}:assistant`]
  : []));
const payoutRows = targetOrderIds.length ? await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'payout_items'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND (record->>'orderId' = ANY(${targetOrderIds}) OR record->>'itemKey' = ANY(${targetEarningKeys}))
` as any[] : [];
const activePayouts = records(payoutRows).filter(item => !item.deletedAt);
const targetOrderIdSet = new Set(targetOrderIds);
const targetPayouts = activePayouts.filter(item => targetOrderIdSet.has(String(item.orderId || ''))
  || targetOrderIds.some(id => String(item.itemKey || '').startsWith(`${id}:`)));
const branchAppointments = allAppointments.filter(item => !item.branchId || item.branchId === branchId);
const unpaidLines = calculateUnpaidStaffEarnings(activeOrders, targetPayouts, branchAppointments, payrollFrom, payrollTo);
const grossLines = calculateUnpaidStaffEarnings(activeOrders, [], branchAppointments, payrollFrom, payrollTo);
const inventory = new Map<string, number>();
for (const order of activeOrders) {
  for (const item of order.items || []) {
    if (item.type === 'product' && item.refId) inventory.set(String(item.refId), (inventory.get(String(item.refId)) || 0) + Number(item.qty || 0));
    for (const used of item.consumedProducts || []) {
      if (used.productId) inventory.set(String(used.productId), (inventory.get(String(used.productId)) || 0) + Number(used.qty || 0));
    }
  }
}
const targetCustomerIds = Array.from(new Set(activeOrders.map(order => String(order.customerId || '')).filter(Boolean)));
const targetRevenueKES = activeOrders.reduce((sum, order) => sum + Number(order.totalByCurrency?.KES || 0), 0);
const beforeDateCounts = Object.fromEntries(
  Array.from(new Set(targetAppointments.map(item => String(item.date || '')))).sort()
    .map(date => [date, targetAppointments.filter(item => String(item.date || '') === date).length]),
);
const suspiciousDates = new Set(['2026-10-25', '2026-10-30']);
const suspiciousAppointments = targetAppointments.filter(item => suspiciousDates.has(String(item.date || ''))).map(appointment => ({
  appointmentId: String(appointment.id), date: appointment.date, status: appointment.status,
  deletedAt: appointment.deletedAt || null, customer: appointment.customerName || null,
  cardNumber: appointment.cardNumber || null,
  orders: targetOrders.filter(order => String(order.appointmentId || '') === String(appointment.id)).map(order => ({
    orderId: String(order.id), createdAt: new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
    deletedAt: order.deletedAt || null, voidReason: order.voidReason || null,
    revenueKES: Number(order.totalByCurrency?.KES || 0),
    payrollWindow: Number(order.createdAt || 0) >= payrollFrom && Number(order.createdAt || 0) < payrollTo,
  })),
}));
const countByStatus = (rows: any[]) => Object.fromEntries(Array.from(new Set(rows.map(item => String(item.status || 'unknown'))))
  .map(status => [status, rows.filter(item => String(item.status || 'unknown') === status).length]));

console.log(JSON.stringify({
  readOnly: true,
  branch: 'Main Branch',
  appointmentsBefore: cutoffDate,
  payrollWindow: { from: '2026-10-31', through: '2026-11-06', timezone: 'Africa/Nairobi' },
  appointmentCount: targetAppointments.length,
  appointmentsByDate: beforeDateCounts,
  appointmentsByStatus: countByStatus(targetAppointments.filter(item => !item.deletedAt)),
  alreadyDeletedAppointmentCount: targetAppointments.filter(item => item.deletedAt).length,
  linkedOrderCount: targetOrders.length,
  activeLinkedOrderCount: activeOrders.length,
  alreadyDeletedOrderCount: targetOrders.filter(item => item.deletedAt).length,
  activeLinkedRevenueKES: targetRevenueKES,
  uniqueCustomersAffected: targetCustomerIds.length,
  stockProductsToRestore: inventory.size,
  activePayoutReferences: targetPayouts.length,
  earningsInPayrollWindow: {
    grossLines: grossLines.length,
    unpaidLines: unpaidLines.length,
    grossKES: grossLines.filter(line => line.currency === 'KES').reduce((sum, line) => sum + line.amount, 0),
    unpaidKES: unpaidLines.filter(line => line.currency === 'KES').reduce((sum, line) => sum + line.amount, 0),
  },
  Oct25AndOct30: suspiciousAppointments,
}, null, 2));