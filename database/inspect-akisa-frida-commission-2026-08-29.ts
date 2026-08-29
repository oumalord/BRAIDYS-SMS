import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [akisaRows, hellenRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND lower(record->>'name') = 'akisa' LIMIT 1`,
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND lower(record->>'name') = 'hellen' LIMIT 1`,
]) as any[];
const akisa = akisaRows[0];
const hellen = hellenRows[0];
if (!akisa || !hellen) throw new Error('Akisa or Hellen staff record was not found');

const rows = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'orders'
  ORDER BY created_at DESC
  LIMIT 5000
` as { id: string; record: any }[];

const order = rows.find(row => row.id === '7b858c27-6e24-4568-a759-e2c1bf4b22e6');
if (!order || String(order.record?.customerName || '').toLowerCase() !== 'frida mwongera') throw new Error('Verified Frida/Akisa completed order was not found');

const items = [...order.record.items];
const jazzyIndex = items.findIndex((item: any) => item.type === 'service' && String(item.name || '').toLowerCase() === 'jazzy' && Number(item.price) === 2500);
if (jazzyIndex < 0) throw new Error('Verified Akisa Jazzy KES 2,500 service was not found');
const jazzy = items[jazzyIndex];
const alreadyCorrected = jazzy.staffId === akisa.id
  && jazzy.helperStaffId === hellen.id
  && Number(jazzy.assistantPayment) === 400
  && Number(jazzy.commission) === 1050;

if (!alreadyCorrected) {
  items[jazzyIndex] = {
    ...jazzy,
    staffId: akisa.id,
    staffName: akisa.record.name,
    helperStaffId: hellen.id,
    helperStaffName: hellen.record.name,
    assistantPayment: 400,
    helperDeduction: 400,
    commissionBase: 2100,
    commissionPct: 50,
    commissionRate: 50,
    commission: 1050,
    commissionParticipants: 1,
    commissionSplit: 'one-staff',
  };
  const corrected = {
    ...order.record,
    items,
    helperDeductions: items.reduce((sum: number, item: any) => sum + (item.type === 'service' ? Number(item.assistantPayment || 0) : 0), 0),
  };
  await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
  try {
    await sql`UPDATE app_records SET record = ${JSON.stringify(corrected)}::jsonb WHERE id = ${order.id} AND collection = 'orders'`;
  } finally {
    await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
  }
}

console.log(JSON.stringify({ orderId: order.id, customerName: order.record.customerName, corrected: !alreadyCorrected, akisaJazzyCommission: 1050, hellenAssistantCompensation: 400 }, null, 2));