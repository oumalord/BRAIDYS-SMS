import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;

await sql`DELETE FROM app_records WHERE collection NOT IN ('salons', 'branches', 'accounts')`;
await sql`DELETE FROM app_records WHERE collection = 'sessions'`;
await sql`DELETE FROM app_records WHERE collection = 'accounts' AND record->>'role' <> 'owner'`;

await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;

console.log('All operational data and logs removed. Salons, branches, and salon owner accounts preserved.');
