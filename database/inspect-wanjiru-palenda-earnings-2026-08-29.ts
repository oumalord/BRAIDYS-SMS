import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [staff, orders, appointments] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders' ORDER BY created_at ASC`,
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments' ORDER BY created_at ASC`,
]) as [{ id: string; record: any }[], { id: string; record: any }[], { id: string; record: any }[]];
const named = (name: string) => staff.filter(member => String(member.record?.name || '').trim().toLowerCase() === name);
const wanjiru = named('wanjiru');
const palenda = named('palenda');
const isIvy = (name: unknown) => String(name || '').trim().toLowerCase().includes('ivy');
const isKnotless = (name: unknown) => /knot|knotless|knottles/.test(String(name || '').toLowerCase());
const ivyKnotless = orders.flatMap(order => (order.record?.items || []).map((item: any, index: number) => ({ order, item, index })))
  .filter(({ order, item }) => isIvy(order.record?.customerName) || (isKnotless(item?.name) && Number(item?.price || 0) === 1700))
  .map(({ order, item, index }) => ({ orderId: order.id, deletedAt: order.record?.deletedAt || null, index, customerName: order.record.customerName, createdAt: order.record.createdAt, service: item.name, price: Number(item.price || 0), staffId: item.staffId || null, staffName: item.staffName || null, helperStaffId: item.helperStaffId || null, helperStaffName: item.helperStaffName || null, assistantPayment: Number(item.assistantPayment ?? item.helperDeduction ?? 0), commission: Number(item.commission || 0) }));
const ivyAppointments = appointments.filter(appointment => isIvy(appointment.record?.customerName) || isKnotless(appointment.record?.serviceName) && Number(appointment.record?.price || 0) === 1700)
  .map(appointment => ({ id: appointment.id, deletedAt: appointment.record?.deletedAt || null, customerName: appointment.record.customerName, serviceName: appointment.record.serviceName, price: appointment.record.price, status: appointment.record.status, staffId: appointment.record.staffId, staffName: appointment.record.staffName }));
const palendaLines = orders.filter(order => !order.record?.deletedAt).flatMap(order => (order.record?.items || []).map((item: any, index: number) => ({ order, item, index })))
  .filter(({ item }) => palenda.some(member => item.staffId === member.id || item.coStaffId === member.id || item.helperStaffId === member.id) || String(item.staffName || '').trim().toLowerCase() === 'palenda' || String(item.coStaffName || '').trim().toLowerCase() === 'palenda' || String(item.helperStaffName || '').trim().toLowerCase() === 'palenda')
  .map(({ order, item, index }) => ({ orderId: order.id, index, customerName: order.record.customerName, service: item.name, price: Number(item.price || 0), staffId: item.staffId || null, staffName: item.staffName || null, coStaffId: item.coStaffId || null, coStaffName: item.coStaffName || null, helperStaffId: item.helperStaffId || null, helperStaffName: item.helperStaffName || null, assistantPayment: Number(item.assistantPayment ?? item.helperDeduction ?? 0), commission: Number(item.commission || 0) }));
console.log(JSON.stringify({ wanjiru: wanjiru.map(member => ({ id: member.id, name: member.record.name })), palenda: palenda.map(member => ({ id: member.id, name: member.record.name })), ivyKnotless, ivyAppointments, palendaLines }, null, 2));