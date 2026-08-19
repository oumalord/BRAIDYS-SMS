import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const operationalCollections = [
  'staff', 'services', 'customers', 'appointments', 'queue', 'orders', 'products',
  'expenses', 'membership_plans', 'membership_purchases', 'promotions', 'reviews',
  'messages', 'mpesa_transactions', 'notifications', 'audit_logs', 'stock_movements',
];

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;

for (const collection of operationalCollections) {
  await sql`DELETE FROM app_records WHERE collection = ${collection}`;
}

await sql`DELETE FROM app_records WHERE collection = 'branches' AND (record->>'salonId' IN ('salon-amalia', 'salon-braidy') OR id IN ('salon-amalia-main', 'salon-braidy-main'))`;
await sql`DELETE FROM app_records WHERE collection = 'salons' AND id IN ('salon-amalia', 'salon-braidy')`;
await sql`DELETE FROM app_records WHERE collection = 'accounts' AND (record->>'email' IN ('owner@amaliasalon.demo', 'owner@braidyssalon.demo') OR id IN ('account-salon-amalia', 'account-salon-braidy'))`;
await sql`DELETE FROM app_records WHERE collection = 'sessions' AND record->>'accountId' IN ('account-salon-amalia', 'account-salon-braidy')`;

await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;

console.log('Demo salon data removed. Database schema and platform admin account preserved.');
