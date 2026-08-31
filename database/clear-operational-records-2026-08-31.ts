import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const retainedCollections = ['salons', 'branches', 'staff', 'services', 'products'];

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
try {
  await sql`DELETE FROM app_records WHERE collection = 'accounts' AND COALESCE(record->>'role', '') = 'customer'`;
  await sql`DELETE FROM app_records WHERE collection <> ALL(${retainedCollections}) AND collection <> 'accounts'`;
} finally {
  await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
  await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
}

const [staffRows, orderRows, appointmentRows, customerRows, accountRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' ORDER BY record->>'name'`,
  sql`SELECT id FROM app_records WHERE collection = 'orders' AND NOT (record ? 'deletedAt')`,
  sql`SELECT id FROM app_records WHERE collection = 'appointments' AND NOT (record ? 'deletedAt')`,
  sql`SELECT id FROM app_records WHERE collection = 'customers' AND NOT (record ? 'deletedAt')`,
  sql`SELECT id, record FROM app_records WHERE collection = 'accounts' ORDER BY record->>'name'`,
]) as [{ id: string; record: any }[], { id: string }[], { id: string }[], { id: string }[], { id: string; record: any }[]];

console.log(JSON.stringify({
  retainedAccounts: accountRows.map(row => ({ name: row.record?.name || '', role: row.record?.role || '' })),
  staffEarnings: staffRows.map(row => ({ name: row.record?.name || 'Unknown', commission: 0, assistant: 0, total: 0 })),
  ownerRevenue: 0,
  activeOrders: orderRows.length,
  activeAppointments: appointmentRows.length,
  activeCustomers: customerRows.length,
}, null, 2));