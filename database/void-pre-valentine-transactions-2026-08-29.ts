import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
type Row = { id: string; tenant_id: string | null; record: any };
const orders = await sql`SELECT id, tenant_id, record FROM app_records WHERE collection = 'orders' ORDER BY created_at ASC` as Row[];
const activeOrders = orders.filter(order => !order.record?.deletedAt);
const valentineOrders = activeOrders.filter(order => String(order.record?.customerName || '').trim().toLowerCase() === 'valentine magato');
if (!valentineOrders.length) throw new Error('No active transaction was found for Valentine Magato');

const cutoff = Math.min(...valentineOrders.map(order => Number(order.record?.createdAt || 0)).filter(Number.isFinite));
if (!cutoff) throw new Error('Valentine Magato has no valid transaction timestamp');
const toVoid = activeOrders.filter(order => Number(order.record?.createdAt || 0) < cutoff);
if (!toVoid.length) {
  console.log(JSON.stringify({ cutoff: new Date(cutoff).toISOString(), voided: 0, message: 'No active transactions exist before Valentine Magato.' }, null, 2));
  process.exit(0);
}

const voidedTotals = toVoid.reduce((totals: Record<string, number>, order) => {
  for (const [currency, amount] of Object.entries(order.record?.totalByCurrency || {})) totals[currency] = (totals[currency] || 0) + Number(amount || 0);
  return totals;
}, {});
const productQuantityRestores = new Map<string, number>();
for (const order of toVoid) {
  for (const item of order.record?.items || []) {
    if (item.type === 'product' && item.refId) productQuantityRestores.set(item.refId, (productQuantityRestores.get(item.refId) || 0) + Number(item.qty || 0));
    for (const used of item.consumedProducts || []) if (used.productId) productQuantityRestores.set(used.productId, (productQuantityRestores.get(used.productId) || 0) + Number(used.qty || 0));
  }
}

const voidedAt = Date.now();
for (const order of toVoid) {
  const voided = { ...order.record, deletedAt: voidedAt, deletedBy: 'owner', voidReason: 'Owner requested removal of every transaction before Valentine Magato' };
  await sql`UPDATE app_records SET record = ${JSON.stringify(voided)}::jsonb WHERE id = ${order.id} AND collection = 'orders' AND NOT (record ? 'deletedAt')`;
}

for (const [productId, quantity] of productQuantityRestores) {
  const [product] = await sql`SELECT id, record FROM app_records WHERE id = ${productId} AND collection = 'products'` as Row[];
  if (!product) continue;
  const restored = { ...product.record, stock: Number(product.record?.stock || 0) + quantity };
  await sql`UPDATE app_records SET record = ${JSON.stringify(restored)}::jsonb WHERE id = ${productId} AND collection = 'products'`;
}

const remainingOrders = activeOrders.filter(order => !toVoid.some(voided => voided.id === order.id));
const affectedCustomerIds = new Set(toVoid.map(order => String(order.record?.customerId || '')).filter(Boolean));
const customerRows = await sql`SELECT id, record FROM app_records WHERE collection = 'customers' AND id = ANY(${[...affectedCustomerIds]})` as Row[];
for (const customer of customerRows) {
  const customerOrders = remainingOrders.filter(order => order.record?.customerId === customer.id);
  const totalSpent = customerOrders.reduce((sum, order) => sum + Number(order.record?.totalByCurrency?.KES || 0), 0);
  const totalSpentUSD = customerOrders.reduce((sum, order) => sum + Number(order.record?.totalByCurrency?.USD || 0), 0);
  const loyaltyPoints = customerOrders.reduce((sum, order) => sum + Math.floor(Number(order.record?.totalByCurrency?.KES || 0) / 100) - Number(order.record?.pointsRedeemed || 0), 0);
  const lastVisit = customerOrders.reduce((latest, order) => Math.max(latest, Number(order.record?.createdAt || 0)), 0) || null;
  const recalculated = { ...customer.record, totalSpent, totalSpentUSD, visits: customerOrders.length, loyaltyPoints: Math.max(0, loyaltyPoints), lastVisit };
  await sql`UPDATE app_records SET record = ${JSON.stringify(recalculated)}::jsonb WHERE id = ${customer.id} AND collection = 'customers'`;
}

const stockRestored = Object.fromEntries(productQuantityRestores);
console.log(JSON.stringify({
  cutoff: new Date(cutoff).toISOString(),
  retainedValentineOrderIds: valentineOrders.map(order => order.id),
  voidedOrderIds: toVoid.map(order => order.id),
  voidedCount: toVoid.length,
  voidedTotals,
  customerBalancesRecalculated: customerRows.map(customer => customer.id),
  stockRestored,
  voidedAt,
}, null, 2));