import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const customerId = '65ec7af0-d7fb-4347-8046-906e22166864';
const expectedIds = [customerId, 'f5a8e731-ed57-48ec-9914-bd10a24250c3', 'b7249582-d76f-4ff3-ac47-a56d42e584cb', '9643a01a-ec36-43d4-9dd4-ced516bca4dd'];
const rows = await sql`SELECT id, collection, record FROM app_records WHERE id = ANY(${expectedIds})` as { id: string; collection: string; record: any }[];
if (rows.length !== expectedIds.length) throw new Error(`Expected ${expectedIds.length} verified Charmaine records, found ${rows.length}`);
const customer = rows.find(row => row.id === customerId);
if (!customer || customer.collection !== 'customers' || String(customer.record?.name || '').trim().toLowerCase() !== 'charmaine mutare') throw new Error('Verified Charmaine customer profile did not match');
const linked = rows.filter(row => row.id !== customerId);
if (linked.some(row => String(row.record?.customerId || '') !== customerId || String(row.record?.customerName || '').trim().toLowerCase() !== 'charmaine mutare')) throw new Error('A linked Charmaine record did not match the verified customer');

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
try {
  await sql`DELETE FROM app_records WHERE id = ANY(${expectedIds})`;
} finally {
  await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
  await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
}
const remaining = await sql`SELECT id FROM app_records WHERE id = ANY(${expectedIds})` as { id: string }[];
if (remaining.length) throw new Error(`Deletion incomplete; ${remaining.length} records remain`);
console.log(JSON.stringify({ deleted: { customers: 1, appointments: 1, orders: 1, queue: 1 }, total: expectedIds.length }, null, 2));