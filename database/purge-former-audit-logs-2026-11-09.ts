import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const confirmation = 'DELETE_ALL_FORMER_AUDIT_LOGS';
const [{ count: countBefore }] = await sql`
  SELECT COUNT(*)::int AS count FROM app_records WHERE collection = 'audit_logs'
` as { count: number }[];

console.log(JSON.stringify({
  mode: process.env.CONFIRM_AUDIT_LOG_PURGE === confirmation ? 'execute' : 'dry-run',
  auditLogsToDelete: countBefore,
}, null, 2));

if (process.env.CONFIRM_AUDIT_LOG_PURGE !== confirmation) {
  console.log(`Dry run only. Set CONFIRM_AUDIT_LOG_PURGE=${confirmation} to permanently delete these audit logs.`);
  process.exit(0);
}

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
try {
  await sql`DELETE FROM app_records WHERE collection = 'audit_logs'`;
} finally {
  await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
}

const [{ count: countAfter }] = await sql`
  SELECT COUNT(*)::int AS count FROM app_records WHERE collection = 'audit_logs'
` as { count: number }[];
console.log(JSON.stringify({ result: 'complete', auditLogsRemaining: countAfter }, null, 2));
if (countAfter !== 0) throw new Error('Audit log purge verification failed');