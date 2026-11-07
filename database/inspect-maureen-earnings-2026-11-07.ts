import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings, currentSundayThroughNowRange } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const collections = ['staff', 'orders', 'payout_items', 'appointments'];
const rowsByCollection = Object.fromEntries(await Promise.all(collections.map(async collection => [
  collection,
  await sql`SELECT id, tenant_id, record FROM app_records WHERE collection = ${collection}` as any[],
]))) as Record<string, any[]>;
const records = (collection: string) => rowsByCollection[collection].map(row => ({
  ...row.record,
  id: String(row.id),
  tenantId: row.record?.tenantId || row.tenant_id,
}));
const staffRows = records('staff').filter(staff => String(staff.name || '').trim().toLowerCase() === 'maureen');
if (!staffRows.length) throw new Error('No matching staff record named Maureen was found');

const range = currentSundayThroughNowRange();
const localDateTime = (value: unknown) => value ? new Date(Number(value)).toLocaleString('en-CA', {
  timeZone: 'Africa/Nairobi', hour12: false,
}) : null;
const reports = await Promise.all(staffRows.map(async staff => {
  const scoped = (collection: string) => records(collection).filter(item => item.tenantId === staff.tenantId
    && (!staff.branchId || !item.branchId || item.branchId === staff.branchId));
  const orders = scoped('orders');
  const payoutItems = scoped('payout_items');
  const appointments = scoped('appointments');
  const appointmentsById = new Map(appointments.map(item => [String(item.id), item]));
  const grossLines = calculateUnpaidStaffEarnings(orders, [], appointments, range.from, Date.now() + 1)
    .filter(line => line.staffId === String(staff.id) && line.currency === 'KES');
  const unpaidLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, range.from, Date.now() + 1)
    .filter(line => line.staffId === String(staff.id) && line.currency === 'KES');
  const orderIds = Array.from(new Set(grossLines.map(line => line.orderId)));
  const auditRows = orderIds.length
    ? await sql`SELECT id, record FROM app_records WHERE collection = 'audit_logs' AND record->>'collection' = 'order' AND record->>'recordId' = ANY(${orderIds})`
    : [];
  const auditByOrderId = new Map((auditRows as any[]).map(row => [String(row.record?.recordId || ''), row.record]));
  const activePayoutKeys = new Set(payoutItems.filter(item => !item.deletedAt).map(item => String(item.itemKey || '')));
  return {
    staff: { id: String(staff.id), name: staff.name, tenantId: staff.tenantId || null, branchId: staff.branchId || null },
    period: { from: localDateTime(range.from), to: localDateTime(Date.now()), timezone: 'Africa/Nairobi' },
    grossKES: grossLines.reduce((sum, line) => sum + line.amount, 0),
    unpaidKES: unpaidLines.reduce((sum, line) => sum + line.amount, 0),
    lines: grossLines.map(line => {
      const order = orders.find(item => String(item.id) === line.orderId);
      const itemIndex = Number(line.itemKey.slice(line.orderId.length + 1).split(':')[0]);
      const item = order?.items?.[itemIndex] || {};
      const appointment = appointmentsById.get(String(order?.appointmentId || ''));
      return {
        orderId: line.orderId,
        orderDate: localDateTime(line.createdAt),
        orderDetails: order ? {
          appointmentId: order.appointmentId || null,
          paymentMethod: order.paymentMethod || null,
          mpesaReceiptNumber: order.mpesaReceiptNumber || null,
          totalByCurrency: order.totalByCurrency || null,
          createdBy: order.createdBy || null,
          deletedAt: localDateTime(order.deletedAt),
        } : null,
        customer: order?.customerName || appointment?.customerName || null,
        appointment: appointment ? {
          id: String(appointment.id), date: appointment.date || null, time: appointment.time || null,
          status: appointment.status || null, deletedAt: localDateTime(appointment.deletedAt),
        } : null,
        orderStatus: order?.paymentStatus || order?.status || null,
        service: line.serviceName,
        role: line.role,
        amountKES: line.amount,
        helperStaffId: item.helperStaffId || null,
        helperStaffName: item.helperStaffName || null,
        assistantPaymentKES: Number(item.assistantPayment ?? item.helperDeduction ?? 0),
        servicePriceKES: Number(item.lineTotalAfterDiscount ?? item.price ?? 0),
        quantity: Number(item.qty || 1),
        staffId: item.staffId || null,
        staffName: item.staffName || null,
        auditTrail: auditByOrderId.has(line.orderId) ? {
          action: auditByOrderId.get(line.orderId).action || null,
          actor: auditByOrderId.get(line.orderId).actor || null,
          createdAt: localDateTime(auditByOrderId.get(line.orderId).createdAt),
          paymentMethod: auditByOrderId.get(line.orderId).recordSnapshot?.paymentMethod || null,
          totalByCurrency: auditByOrderId.get(line.orderId).recordSnapshot?.totalByCurrency || null,
          snapshotItems: (auditByOrderId.get(line.orderId).recordSnapshot?.items || []).map((snapshotItem: any) => ({
            name: snapshotItem.name || snapshotItem.serviceName || null,
            type: snapshotItem.type || null,
            price: snapshotItem.price ?? null,
            assistantPayment: snapshotItem.assistantPayment ?? snapshotItem.helperDeduction ?? null,
            helperStaffId: snapshotItem.helperStaffId || null,
          })),
        } : null,
        itemKey: line.itemKey,
        status: activePayoutKeys.has(line.itemKey) ? 'paid' : 'unpaid',
        payoutRecords: payoutItems.filter(payout => String(payout.itemKey || '') === line.itemKey).map(payout => ({
          id: String(payout.id),
          amountKES: Number(payout.commission || 0),
          createdAt: localDateTime(payout.createdAt),
          deletedAt: localDateTime(payout.deletedAt),
          deletionReason: payout.deletionReason || null,
        })),
      };
    }),
  };
}));

console.log(JSON.stringify({ readOnly: true, reports }, null, 2));