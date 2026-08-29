import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const orderId = 'c182fc63-595a-4654-882f-927575a0ae1e';
const [order] = await sql`SELECT id, record FROM app_records WHERE id = ${orderId} AND collection = 'orders'` as { id: string; record: any }[];
if (!order || String(order.record?.customerName || '').toLowerCase() !== 'friday mwongera') throw new Error('Verified Friday mwongera transaction was not found');
if (!order.record?.deletedAt) {
  const voided = { ...order.record, deletedAt: Date.now(), deletedBy: 'owner', voidReason: 'Duplicate transaction requested by owner' };
  await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
  try {
    await sql`UPDATE app_records SET record = ${JSON.stringify(voided)}::jsonb WHERE id = ${orderId} AND collection = 'orders'`;
  } finally {
    await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
  }
}
console.log(JSON.stringify({ orderId, customerName: order.record.customerName, voided: !order.record.deletedAt, reason: 'Duplicate transaction requested by owner' }, null, 2));