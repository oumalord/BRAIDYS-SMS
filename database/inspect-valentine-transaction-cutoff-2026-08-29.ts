import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const orders = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' ORDER BY created_at ASC` as { id: string; record: any }[];
const activeOrders = orders.filter(order => !order.record?.deletedAt);
const valentineOrders = activeOrders.filter(order => String(order.record?.customerName || '').trim().toLowerCase() === 'valentine magato');
if (!valentineOrders.length) throw new Error('No active transaction was found for Valentine Magato');

const cutoff = Math.min(...valentineOrders.map(order => Number(order.record?.createdAt || 0)).filter(Number.isFinite));
if (!cutoff) throw new Error('Valentine Magato has no valid transaction timestamp');
const beforeCutoff = activeOrders.filter(order => Number(order.record?.createdAt || 0) < cutoff);
const totals = beforeCutoff.reduce((sum: Record<string, number>, order) => {
  for (const [currency, amount] of Object.entries(order.record?.totalByCurrency || {})) sum[currency] = (sum[currency] || 0) + Number(amount || 0);
  return sum;
}, {});

console.log(JSON.stringify({
  cutoff: new Date(cutoff).toISOString(),
  valentineOrders: valentineOrders.map(order => ({ id: order.id, createdAt: order.record.createdAt, totalByCurrency: order.record.totalByCurrency })),
  beforeCutoff: { count: beforeCutoff.length, totals, orders: beforeCutoff.map(order => ({ id: order.id, customerName: order.record.customerName, createdAt: order.record.createdAt, totalByCurrency: order.record.totalByCurrency })) },
}, null, 2));