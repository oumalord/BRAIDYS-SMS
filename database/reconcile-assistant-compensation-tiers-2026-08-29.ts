import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
function assistantCompensation(serviceFee: number, hasSpecialBraid = false): number {
  if (hasSpecialBraid) return 400;
  if (serviceFee <= 1800) return 200;
  if (serviceFee <= 2400) return 300;
  if (serviceFee <= 3300) return 400;
  return 500;
}

const rows = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' ORDER BY created_at ASC` as { id: string; record: any }[];
const updates: { id: string; record: any }[] = [];
for (const row of rows) {
  if (row.record?.deletedAt) continue;
  const items = Array.isArray(row.record?.items) ? row.record.items : [];
  let changed = false;
  const correctedItems = items.map((item: any) => {
    if (item.type !== 'service' || !item.helperStaffId) return item;
    const serviceFee = Number(item.price || 0) * Number(item.qty || 1);
    const hasSpecialBraid = (item.consumedProducts || []).some((product: any) => ['amara', 'diani'].includes(String(product?.name || '').trim().toLowerCase()));
    const assistantPayment = assistantCompensation(serviceFee, hasSpecialBraid);
    const serviceRevenue = Number(item.lineTotalAfterDiscount ?? serviceFee) || 0;
    const productCost = Math.max(0, Number(item.productCost || 0));
    const commissionBase = Math.max(0, serviceRevenue - productCost - assistantPayment);
    const rate = Number(item.commissionPct ?? item.commissionRate ?? 50);
    const commission = commissionBase * (Number.isFinite(rate) ? rate / 100 : 0.5);
    if (Number(item.assistantPayment) === assistantPayment && Number(item.helperDeduction) === assistantPayment && Number(item.commissionBase) === commissionBase && Number(item.commission) === commission) return item;
    changed = true;
    return { ...item, assistantPayment, helperDeduction: assistantPayment, commissionBase, commission };
  });
  if (changed) updates.push({ id: row.id, record: { ...row.record, items: correctedItems, helperDeductions: correctedItems.reduce((sum: number, item: any) => sum + (item.type === 'service' ? Number(item.assistantPayment || 0) : 0), 0) } });
}

if (updates.length) {
  await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
  try {
    for (const update of updates) await sql`UPDATE app_records SET record = ${JSON.stringify(update.record)}::jsonb WHERE id = ${update.id} AND collection = 'orders'`;
  } finally {
    await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
  }
}
console.log(`Reconciled ${updates.length} assisted service order${updates.length === 1 ? '' : 's'} to the assistant compensation tiers.`);