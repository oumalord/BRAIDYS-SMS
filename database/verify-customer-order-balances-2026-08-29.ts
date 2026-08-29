import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [customers, orders] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'customers' AND NOT (record ? 'deletedAt')`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND NOT (record ? 'deletedAt')`,
]) as [{ id: string; record: any }[], { id: string; record: any }[]];

const mismatches = customers.flatMap(customer => {
  const customerOrders = orders.filter(order => order.record?.customerId === customer.id);
  const expected = {
    totalSpent: customerOrders.reduce((sum, order) => sum + Number(order.record?.totalByCurrency?.KES || 0), 0),
    totalSpentUSD: customerOrders.reduce((sum, order) => sum + Number(order.record?.totalByCurrency?.USD || 0), 0),
    visits: customerOrders.length,
    loyaltyPoints: Math.max(0, customerOrders.reduce((sum, order) => sum + Math.floor(Number(order.record?.totalByCurrency?.KES || 0) / 100) - Number(order.record?.pointsRedeemed || 0), 0)),
    lastVisit: customerOrders.reduce((latest, order) => Math.max(latest, Number(order.record?.createdAt || 0)), 0) || null,
  };
  const actual = customer.record || {};
  return ['totalSpent', 'totalSpentUSD', 'visits', 'loyaltyPoints', 'lastVisit'].some(key => Number(actual[key] || 0) !== Number(expected[key] || 0))
    ? [{ id: customer.id, name: actual.name, actual: { totalSpent: actual.totalSpent || 0, totalSpentUSD: actual.totalSpentUSD || 0, visits: actual.visits || 0, loyaltyPoints: actual.loyaltyPoints || 0, lastVisit: actual.lastVisit || null }, expected }]
    : [];
});

console.log(JSON.stringify({ activeOrderCount: orders.length, customersChecked: customers.length, mismatches }, null, 2));
if (mismatches.length) process.exitCode = 1;