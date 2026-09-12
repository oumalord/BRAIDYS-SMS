import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);

// Keep business setup (salons, branches, staff, services, accounts, promotions, membership plans).
// Everything else is operational/transactional data and gets wiped for a clean start.
const retainedCollections = ['salons', 'branches', 'staff', 'services', 'accounts', 'membership_plans', 'promotions'];

const [{ count: totalBefore }] = await sql`SELECT COUNT(*)::int AS count FROM app_records WHERE collection <> ALL(${retainedCollections})` as { count: number }[];

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
try {
  await sql`DELETE FROM app_records WHERE collection <> ALL(${retainedCollections})`;
  await sql`
    UPDATE app_records
    SET record = jsonb_set(record, '{status}', '"available"')
    WHERE collection = 'staff' AND record->>'status' IS DISTINCT FROM 'available'
  `;
} finally {
  await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
  await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
}

const [{ count: totalAfter }] = await sql`SELECT COUNT(*)::int AS count FROM app_records WHERE collection <> ALL(${retainedCollections})` as { count: number }[];
const remaining = await sql`SELECT collection, COUNT(*)::int AS count FROM app_records GROUP BY collection ORDER BY collection` as { collection: string; count: number }[];

console.log(`Fresh start complete. Removed ${totalBefore - totalAfter} operational record(s) (appointments, orders, customers, expenses, payouts, queue, reviews, messages, audit logs, M-Pesa logs, POS drafts, notifications).`);
console.log('Remaining collections:', JSON.stringify(remaining, null, 2));
