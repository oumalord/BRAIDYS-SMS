import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { staffCommission } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const from = Date.parse('2026-09-19T21:00:00.000Z');
const to = Date.parse('2026-09-26T21:00:00.000Z');
const [staffRows, appointmentRows, orderRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders'`,
]) as any;

const staff = new Map(staffRows.map((row: any) => [String(row.id), String(row.record?.name || 'Unknown staff')]));
const appointments = new Map(appointmentRows
  .filter((row: any) => !row.record?.deletedAt)
  .map((row: any) => [String(row.id), row.record]));
const rows: any[] = [];

for (const row of orderRows) {
  const order = row.record;
  if (order?.deletedAt || Number(order?.createdAt || 0) < from || Number(order?.createdAt || 0) >= to) continue;
  const appointment = appointments.get(String(order.appointmentId || '')) || {};
  if (String(appointment.date || '') < '2026-09-20' || String(appointment.date || '') > '2026-09-26') continue;
  for (const [index, item] of (Array.isArray(order.items) ? order.items : []).entries()) {
    if (item.type !== 'service') continue;
    const revenue = Number(item.lineTotalAfterDiscount ?? Number(item.price || 0) * Number(item.qty || 1)) || 0;
    const assistant = Math.max(0, Number(item.assistantPayment ?? item.helperDeduction ?? 0));
    const primary = item.staffId || appointment.staffId;
    const commissionItem = primary === item.staffId ? item : { ...item, staffId: primary };
    const roles = [
      primary && { id: primary, role: 'commission', amount: staffCommission(commissionItem, primary) },
      item.coStaffId && { id: item.coStaffId, role: 'commission', amount: staffCommission(item, item.coStaffId) },
      item.thirdStaffId && { id: item.thirdStaffId, role: 'commission', amount: staffCommission(item, item.thirdStaffId) },
      item.helperStaffId && { id: item.helperStaffId, role: 'assistant', amount: assistant },
    ].filter(Boolean) as any[];
    for (const role of roles) {
      rows.push({
        staffId: String(role.id),
        staff: staff.get(String(role.id)) || 'Unknown staff',
        date: new Date(Number(order.createdAt)).toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }),
        appointmentDate: appointment.date || null,
        appointmentId: String(order.appointmentId || ''),
        customer: order.customerName || appointment.customerName || 'Walk-in Customer',
        service: String(item.name || appointment.serviceName || 'Service').trim(),
        role: role.role,
        amount: Math.round((Number(role.amount) || 0) * 100) / 100,
        orderId: String(row.id),
        itemIndex: index,
        revenue,
        commissionBase: Math.max(0, Number(item.commissionBase ?? revenue - Number(item.productCost || 0) - assistant) || 0),
      });
    }
  }
}

const totals = new Map<string, any>();
for (const row of rows) {
  const total = totals.get(row.staffId) || { staffId: row.staffId, staff: row.staff, commission: 0, assistant: 0, total: 0, lines: 0 };
  total[row.role === 'assistant' ? 'assistant' : 'commission'] += row.amount;
  total.total += row.amount;
  total.lines += 1;
  totals.set(row.staffId, total);
}

console.log(JSON.stringify({
  period: { from: '2026-09-20', to: '2026-09-26', timezone: 'Africa/Nairobi' },
  counts: { completedOrders: new Set(rows.map(row => row.orderId)).size, earningLines: rows.length },
  totals: Array.from(totals.values()).sort((left, right) => right.total - left.total),
  rows: rows.sort((left, right) => left.staff.localeCompare(right.staff) || left.date.localeCompare(right.date) || left.orderId.localeCompare(right.orderId) || left.itemIndex - right.itemIndex),
}, null, 2));