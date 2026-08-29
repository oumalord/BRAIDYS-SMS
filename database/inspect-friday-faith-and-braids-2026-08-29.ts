import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [staffRows, orderRows, productRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND lower(record->>'name') = 'faith' LIMIT 1`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders' ORDER BY created_at ASC`,
  sql`SELECT id, record FROM app_records WHERE collection = 'products' ORDER BY created_at ASC`,
]) as any[];
const faith = staffRows[0];
if (!faith) throw new Error('Faith staff record was not found');

const fridayOrders = (orderRows as { id: string; record: any }[]).filter(order => /frida|friday/.test(String(order.record?.customerName || '').toLowerCase()));
const faithLines: any[] = [];
for (const order of orderRows as { id: string; record: any }[]) {
  for (const [index, item] of (order.record?.items || []).entries()) {
    if (item.type !== 'service') continue;
    const role = item.staffId === faith.id ? 'primary' : item.coStaffId === faith.id ? 'co-staff' : item.helperStaffId === faith.id ? 'assistant' : null;
    if (!role) continue;
    faithLines.push({ orderId: order.id, customerName: order.record.customerName, createdAt: order.record.createdAt, index, role, service: item.name, price: item.price, rate: item.commissionPct ?? item.commissionRate, commission: item.commission, assistantCompensation: item.assistantPayment ?? item.helperDeduction ?? 0 });
  }
}
const faithTotal = faithLines.reduce((sum, line) => sum + Number(line.role === 'assistant' ? line.assistantCompensation : line.commission || 0), 0);
const braidProducts = (productRows as { id: string; record: any }[]).filter(product => /amara|diani/.test(String(product.record?.name || '').toLowerCase())).map(product => ({ id: product.id, name: product.record.name, price: product.record.price, cost: product.record.cost, stock: product.record.stock }));

console.log(JSON.stringify({ fridayOrders: fridayOrders.map(order => ({ id: order.id, customerName: order.record.customerName, createdAt: order.record.createdAt, totalByCurrency: order.record.totalByCurrency, items: order.record.items })), faith: { id: faith.id, name: faith.record.name, lines: faithLines, total: faithTotal }, braidProducts }, null, 2));