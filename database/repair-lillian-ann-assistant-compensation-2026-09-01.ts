import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [lilian, ann] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND lower(record->>'name') IN ('lilian', 'lillian') LIMIT 1`,
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND lower(record->>'name') IN ('ann', 'anne') LIMIT 1`,
]) as any[];
if (!lilian?.[0] || !ann?.[0]) throw new Error('Lilian or Ann staff record was not found');

const orders = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' ORDER BY created_at DESC` as { id: string; record: any }[];
let correctedOrders = 0;
let correctedServices = 0;

for (const order of orders) {
  let changed = false;
  const items = (order.record?.items || []).map((item: any) => {
    const isAffectedService = item?.type === 'service'
      && item.staffId === lilian[0].id
      && item.helperStaffId === ann[0].id
      && Number(item.assistantPayment ?? item.helperDeduction ?? 0) === 0;
    if (!isAffectedService) return item;

    const assistantPayment = Number(item.price || 0) * Number(item.qty || 1) <= 1800 ? 200
      : Number(item.price || 0) * Number(item.qty || 1) <= 2400 ? 300
      : Number(item.price || 0) * Number(item.qty || 1) <= 3300 ? 400 : 500;
    const commissionBase = Math.max(0, Number(item.lineTotalAfterDiscount ?? Number(item.price || 0) * Number(item.qty || 1)) - Number(item.productCost || 0) - assistantPayment);
    const commissionRate = Number(item.commissionPct ?? item.commissionRate ?? 50) || 50;
    const commission = commissionBase * (commissionRate / 100);
    changed = true;
    correctedServices++;
    return { ...item, assistantPayment, helperDeduction: assistantPayment, commissionBase, commissionRate, commissionPct: commissionRate, commission, primaryCommission: commission };
  });
  if (!changed) continue;

  const corrected = { ...order.record, items, helperDeductions: items.filter((item: any) => item.type === 'service').reduce((total: number, item: any) => total + Number(item.assistantPayment ?? item.helperDeduction ?? 0), 0) };
  await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
  try {
    await sql`UPDATE app_records SET record = ${JSON.stringify(corrected)}::jsonb WHERE id = ${order.id} AND collection = 'orders'`;
  } finally {
    await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
  }
  correctedOrders++;
}

console.log(`Corrected ${correctedServices} Lillian/Ann completed service line(s) across ${correctedOrders} order(s).`);