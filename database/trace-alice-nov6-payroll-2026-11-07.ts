import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const tenantId = 'salon-852a7423ca75d9db';
const date = '2026-11-06';
const from = Date.parse('2026-10-31T00:00:00+03:00');
const to = Date.parse('2026-11-07T00:00:00+03:00');
const sql = neon(databaseUrl);
const [staffRows, appointmentRows, orderRows, payoutRows, auditRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})`,
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments' AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId}) AND record->>'date' = ${date}`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})`,
  sql`SELECT id, record FROM app_records WHERE collection = 'payout_items' AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})`,
  sql`SELECT record FROM app_records WHERE collection = 'audit_logs' AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId}) AND record->>'createdAt' >= '0'`,
]);
const records = (rows: any[]) => rows.map(row => ({ ...row.record, id: String(row.id) }));
const staff = records(staffRows);
const alice = staff.find(member => String(member.name || '').trim().toLowerCase() === 'alice');
if (!alice) throw new Error('Alice staff record was not found.');
const appointments = records(appointmentRows).filter(item => !item.branchId || item.branchId === 'salon-852a7423ca75d9db-main');
const appointmentIds = new Set(appointments.filter(item => String(item.staffId || '') === String(alice.id)
  || String(item.staffName || '').trim().toLowerCase() === 'alice').map(item => String(item.id)));
const orders = records(orderRows).filter(order => appointmentIds.has(String(order.appointmentId || ''))
  && (!order.branchId || order.branchId === 'salon-852a7423ca75d9db-main'));
const payouts = records(payoutRows);
const lines = calculateUnpaidStaffEarnings(orders, payouts, appointments, from, to);
const auditLogs = records(auditRows);
console.log(JSON.stringify({
  readOnly: true,
  staff: { id: alice.id, name: alice.name },
  period: { from: new Date(from).toISOString(), toExclusive: new Date(to).toISOString() },
  appointments: appointments.filter(item => appointmentIds.has(String(item.id))).map(appointment => ({
    id: appointment.id, date: appointment.date, time: appointment.time, cardNumber: appointment.cardNumber,
    customer: appointment.customerName, status: appointment.status, deleted: Boolean(appointment.deletedAt),
    staffId: appointment.staffId || null, staffName: appointment.staffName || null,
    orders: orders.filter(order => String(order.appointmentId) === String(appointment.id)).map(order => {
      const orderLines = calculateUnpaidStaffEarnings([order], [], appointments, from, Date.now() + 1);
      return {
        id: order.id,
        createdAt: Number(order.createdAt || 0),
        createdAtLocal: new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
        deleted: Boolean(order.deletedAt),
        deletionReason: order.voidReason || null,
        revenueKES: Number(order.totalByCurrency?.KES || 0),
        items: (order.items || []).map((item: any, index: number) => ({
          index, type: item.type, name: item.name, refId: item.refId,
          staffId: item.staffId || null, staffName: item.staffName || null,
          commission: item.commission ?? null, commissionPct: item.commissionPct ?? null,
          assistantPayment: item.assistantPayment ?? item.helperDeduction ?? null,
        })),
        calculatedLines: orderLines.map(line => ({ staffId: line.staffId, role: line.role, amount: line.amount, itemKey: line.itemKey, currency: line.currency })),
        aliceLines: orderLines.filter(line => line.staffId === String(alice.id)).map(line => ({ role: line.role, amount: line.amount, itemKey: line.itemKey })),
        payoutMarkers: payouts.filter(item => String(item.orderId || '') === String(order.id)
          || order.items?.some((_line: any, index: number) => String(item.itemKey || '').startsWith(`${order.id}:${index}`)))
          .map(item => ({ itemKey: item.itemKey, deleted: Boolean(item.deletedAt), amount: item.amount || item.commission || null })),
        orderAudit: auditLogs.filter(log => String(log.recordId || '') === String(order.id)).map(log => ({ action: log.action, actor: log.actor, createdAt: log.createdAt, reason: log.reason || null })),
      };
    }),
  })),
  aliceLinesCurrentPayroll: lines.filter(line => line.staffId === String(alice.id)).map(line => ({ orderId: line.orderId, itemKey: line.itemKey, amount: line.amount })),
  aliceCurrentPayrollKES: lines.filter(line => line.staffId === String(alice.id) && line.currency === 'KES').reduce((sum, line) => sum + line.amount, 0),
}, null, 2));
