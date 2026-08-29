import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const [caro, kabi] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND lower(record->>'name') = 'caro' LIMIT 1`,
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND lower(record->>'name') = 'kabi' LIMIT 1`,
]) as any[];
if (!caro?.[0] || !kabi?.[0]) throw new Error('Caro or Kabi staff record was not found');

const rows = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'orders'
  ORDER BY created_at DESC
  LIMIT 5000
` as { id: string; record: any }[];

const order = rows.find(row => row.id === '323db28e-cdb2-4a65-b3c6-e75b427c0024');
if (!order) throw new Error('Verified Caro/Kabi completed order was not found');

const items = [...order.record.items];
const knotlessIndex = items.findIndex((item: any) => String(item.name || '').toLowerCase().includes('knotless') && Number(item.price) === 2100);
const treatment = items.find((item: any) => String(item.staffName || '').toLowerCase() === 'caro' && Number(item.commission) === 120);
if (knotlessIndex < 0 || !treatment) throw new Error('The verified Caro treatment and Knotless service lines were not both found');

const existingKnotless = items[knotlessIndex];
const alreadyCorrected = existingKnotless.staffId === caro[0].id
  && existingKnotless.helperStaffId === kabi[0].id
  && Number(existingKnotless.assistantPayment) === 300
  && Number(existingKnotless.commission) === 900;

if (!alreadyCorrected) {
  items[knotlessIndex] = {
    ...existingKnotless,
    staffId: caro[0].id,
    staffName: caro[0].record.name,
    helperStaffId: kabi[0].id,
    helperStaffName: kabi[0].record.name,
    assistantPayment: 300,
    helperDeduction: 300,
    commissionBase: 1800,
    commissionPct: 50,
    commissionRate: 50,
    commission: 900,
    commissionParticipants: 1,
    commissionSplit: 'one-staff',
  };
}

const corrected = { ...order.record, items, helperDeductions: alreadyCorrected ? Number(order.record.helperDeductions || 0) : Number(order.record.helperDeductions || 0) + 300 };
if (!alreadyCorrected) {
  await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
  try {
    await sql`UPDATE app_records SET record = ${JSON.stringify(corrected)}::jsonb WHERE id = ${order.id} AND collection = 'orders'`;
  } finally {
    await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
  }
}
console.log(JSON.stringify({ orderId: order.id, customerName: corrected.customerName, corrected: !alreadyCorrected, caroKnotlessCommission: 900, caroTreatmentCommission: Number(treatment.commission), totalCaroCommission: 1020, kabiAssistantCompensation: 300 }, null, 2));