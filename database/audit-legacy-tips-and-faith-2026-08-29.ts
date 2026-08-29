import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [staffRows, orders] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND lower(record->>'name') = 'faith' LIMIT 1`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders' ORDER BY created_at ASC`,
]) as any[];
const faith = staffRows[0];
if (!faith) throw new Error('Faith staff record was not found');

const legacyTipOrders = (orders as { id: string; record: any }[]).flatMap(order => {
  const orderTip = Number(order.record?.tipAmount || 0);
  const lines = (order.record?.items || []).flatMap((item: any, index: number) => Number(item?.tipShare || 0) > 0 ? [{ index, tipShare: Number(item.tipShare) }] : []);
  return orderTip > 0 || lines.length ? [{ id: order.id, customerName: order.record.customerName, deletedAt: order.record.deletedAt || null, tipAmount: orderTip, tipShares: lines, totalByCurrency: order.record.totalByCurrency }] : [];
});

const faithLines = (orders as { id: string; record: any }[]).flatMap(order => (order.record?.items || []).flatMap((item: any, index: number) => {
  const role = item.type !== 'service' ? null : item.staffId === faith.id ? 'primary' : item.coStaffId === faith.id ? 'co-staff' : item.helperStaffId === faith.id ? 'assistant' : null;
  if (!role) return [];
  return [{ orderId: order.id, customerName: order.record.customerName, createdAt: order.record.createdAt, deletedAt: order.record.deletedAt || null, role, index, service: item.name, commission: Number(item.commission || 0), assistantCompensation: Number(item.assistantPayment ?? item.helperDeduction ?? 0) }];
}));

const activeFaithTotal = faithLines.filter(line => !line.deletedAt).reduce((sum, line) => sum + (line.role === 'assistant' ? line.assistantCompensation : line.commission), 0);
console.log(JSON.stringify({ legacyTipOrders, faith: { id: faith.id, lines: faithLines, activeTotal: activeFaithTotal } }, null, 2));