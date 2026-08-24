import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const sql = neon(databaseUrl);

const staff = await sql.query("SELECT id FROM app_records WHERE collection='staff' AND record->>'salonName'='BRAIDYS' AND record->>'branchName'='Main Branch' AND record->>'name'='Yulie' AND record->>'phone'='0797868442' LIMIT 1");
if (!staff.length) throw new Error('Yulie staff record not found');
const staffId = staff[0].id;
await sql.query("UPDATE app_records SET record=jsonb_set(record,'{name}','\"Lydia\"') WHERE id=$1 AND collection='staff'", [staffId]);
await sql.query("UPDATE app_records SET record=jsonb_set(record,'{name}','\"Lydia\"') WHERE collection='accounts' AND record->>'staffId'=$1", [staffId]);
console.log(`Renamed Yulie to Lydia (${staffId}).`);
