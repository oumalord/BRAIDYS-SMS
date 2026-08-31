import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [appointments, orders] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments' AND record->>'date' = '2026-08-29' AND record->>'cardNumber' = '1'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders'`,
]) as [{ id: string; record: any }[], { id: string; record: any }[]];

const appointmentIds = new Set(appointments.map(appointment => appointment.id));
const linkedOrders = orders.filter(order => appointmentIds.has(String(order.record?.appointmentId || '')));
const aliceOrders = orders.filter(order => (order.record?.items || []).some((item: any) => [item.staffName, item.coStaffName, item.thirdStaffName, item.helperStaffName].some(name => String(name || '').trim().toLowerCase().includes('alice'))));

console.log(JSON.stringify({
  appointments: appointments.map(appointment => ({ id: appointment.id, ...appointment.record })),
  linkedOrders: linkedOrders.map(order => ({ id: order.id, ...order.record })),
  aliceOrders: aliceOrders.map(order => ({ id: order.id, appointmentId: order.record?.appointmentId || null, customerName: order.record?.customerName, createdAt: order.record?.createdAt, deletedAt: order.record?.deletedAt || null, items: order.record?.items || [] })),
}, null, 2));