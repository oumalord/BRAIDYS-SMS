import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const sql = neon(databaseUrl);

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
const [diana] = await sql`SELECT id FROM app_records WHERE collection='staff' AND record->>'salonName'='BRAIDYS' AND record->>'branchName'='Main Branch' AND record->>'name'='Diana' AND record->>'phone'='0748921947' LIMIT 1` as any[];
if (!diana) throw new Error('Receptionist Diana was not found');
await sql`UPDATE app_records SET record = jsonb_set(record, '{name}', '"Mwaka"') WHERE id=${diana.id} AND collection='staff'`;
await sql`UPDATE app_records SET record = jsonb_set(record, '{name}', '"Mwaka"') WHERE collection='accounts' AND record->>'staffId'=${diana.id}`;
await sql`DELETE FROM app_records WHERE collection='accounts' AND record->>'name'='Steve'`;
await sql`DELETE FROM app_records WHERE collection='staff' AND record->>'salonName'='BRAIDYS' AND record->>'branchName'='Main Branch' AND record->>'name'='Steve'`;
await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;

const staff = await sql`SELECT record->>'name' AS name, record->>'phone' AS phone, record->>'role' AS role FROM app_records WHERE collection='staff' AND record->>'salonName'='BRAIDYS' AND record->>'branchName'='Main Branch' ORDER BY created_at`;
const receptionists = staff.filter((row: any) => row.role === 'Receptionist');
console.log('Main Branch staff:');
for (const row of staff) console.log(`${row.name}: ${row.phone || 'no phone'}`);
console.log('Receptionists:');
for (const row of receptionists) console.log(`${row.name}: ${row.phone}`);
console.log(`Counts: staff=${staff.length}, receptionists=${receptionists.length}`);
