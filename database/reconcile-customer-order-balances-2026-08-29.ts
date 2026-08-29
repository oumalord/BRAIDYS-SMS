import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [customers, orders] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'customers' AND NOT (record ? 'deletedAt')`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND NOT (record ? 'deletedAt')`,
]) as [{ id: string; record: any }[], { id: string; record: any }[]];

const updated: string[] = [];
for (const customer of customers) {
  const customerOrders = orders.filter(order => order.record?.customerId === customer.id);
  const totals = {
    totalSpent: customerOrders.reduce((sum, order) => sum + Number(order.record?.totalByCurrency?.KES || 0), 0),
    totalSpentUSD: customerOrders.reduce((sum, order) => sum + Number(order.record?.totalByCurrency?.USD || 0), 0),
    visits: customerOrders.length,
    loyaltyPoints: Math.max(0, customerOrders.reduce((sum, order) => sum + Math.floor(Number(order.record?.totalByCurrency?.KES || 0) / 100) - Number(order.record?.pointsRedeemed || 0), 0)),
    lastVisit: customerOrders.reduce((latest, order) => Math.max(latest, Number(order.record?.createdAt || 0)), 0) || null,
  };
  const current = customer.record || {};
  if (Object.entries(totals).every(([key, value]) => Number(current[key] || 0) === Number(value || 0))) continue;
  await sql`UPDATE app_records SET record = ${JSON.stringify({ ...current, ...totals })}::jsonb WHERE id = ${customer.id} AND collection = 'customers'`;
  updated.push(customer.id);
}

console.log(JSON.stringify({ customersChecked: customers.length, activeOrderCount: orders.length, updatedCustomerIds: updated }, null, 2));