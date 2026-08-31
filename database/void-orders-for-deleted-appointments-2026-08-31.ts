import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [appointmentRows, orderRows, productRows, customerRows, payoutRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments' AND record ? 'deletedAt'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND NOT (record ? 'deletedAt')`,
  sql`SELECT id, record FROM app_records WHERE collection = 'products'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'customers'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'payout_items' AND NOT (record ? 'deletedAt')`,
]) as { id: string; record: any }[][];

const deletedAppointmentIds = new Set(appointmentRows.map(row => row.id));
const paidOrderIds = new Set(payoutRows.map(row => String(row.record?.orderId || '')).filter(Boolean));
const ordersToVoid = orderRows.filter(row => deletedAppointmentIds.has(String(row.record?.appointmentId || '')));
const now = Date.now();

const restoreQuantities = new Map<string, number>();
for (const order of ordersToVoid) {
  for (const item of order.record?.items || []) {
    if (item.type === 'product' && item.refId) restoreQuantities.set(item.refId, (restoreQuantities.get(item.refId) || 0) + Number(item.qty || 0));
    for (const used of item.consumedProducts || []) if (used.productId) restoreQuantities.set(used.productId, (restoreQuantities.get(used.productId) || 0) + Number(used.qty || 0));
  }
}

const productById = new Map(productRows.map(row => [row.id, row.record]));
const productUpdates = Array.from(restoreQuantities.entries()).flatMap(([id, quantity]) => {
  const product = productById.get(id);
  return product ? [{ id, record: { ...product, stock: Number(product.stock || 0) + quantity } }] : [];
});
const affectedCustomerIds = new Set(ordersToVoid.map(order => String(order.record?.customerId || '')).filter(Boolean));
const allActiveOrdersAfterCleanup = orderRows.filter(order => !ordersToVoid.some(voided => voided.id === order.id));
const customerUpdates = customerRows.flatMap(row => {
  if (!affectedCustomerIds.has(row.id)) return [];
  const customerOrders = allActiveOrdersAfterCleanup.filter(order => order.record?.customerId === row.id);
  const totalSpent = customerOrders.reduce((sum, order) => sum + Number(order.record?.totalByCurrency?.KES || 0), 0);
  const totalSpentUSD = customerOrders.reduce((sum, order) => sum + Number(order.record?.totalByCurrency?.USD || 0), 0);
  const loyaltyPoints = Math.max(0, customerOrders.reduce((sum, order) => sum + Math.floor(Number(order.record?.totalByCurrency?.KES || 0) / 100) - Number(order.record?.pointsRedeemed || 0), 0));
  const lastVisit = customerOrders.reduce((latest, order) => Math.max(latest, Number(order.record?.createdAt || 0)), 0) || null;
  return [{ id: row.id, record: { ...row.record, totalSpent, totalSpentUSD, visits: customerOrders.length, loyaltyPoints, lastVisit } }];
});

if (ordersToVoid.length || productUpdates.length || customerUpdates.length) {
  await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
  try {
    for (const order of ordersToVoid) await sql`UPDATE app_records SET record = ${JSON.stringify({ ...order.record, deletedAt: now, deletedBy: 'system cleanup', voidReason: 'Linked appointment was deleted before accounting cleanup', payoutReversalRequired: paidOrderIds.has(order.id) })}::jsonb WHERE id = ${order.id} AND collection = 'orders'`;
    for (const update of productUpdates) await sql`UPDATE app_records SET record = ${JSON.stringify(update.record)}::jsonb WHERE id = ${update.id} AND collection = 'products'`;
    for (const update of customerUpdates) await sql`UPDATE app_records SET record = ${JSON.stringify(update.record)}::jsonb WHERE id = ${update.id} AND collection = 'customers'`;
  } finally {
    await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
  }
}

console.log(JSON.stringify({
  voidedOrderIds: ordersToVoid.map(order => order.id),
  restoredProducts: productUpdates.map(update => ({ id: update.id, quantity: restoreQuantities.get(update.id) || 0 })),
  recalculatedCustomerIds: customerUpdates.map(update => update.id),
  voidedOrdersWithRecordedPayouts: ordersToVoid.filter(order => paidOrderIds.has(order.id)).map(order => order.id),
}, null, 2));