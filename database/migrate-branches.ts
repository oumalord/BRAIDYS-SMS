import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const salons = await sql`SELECT id FROM app_records WHERE collection = 'salons' AND record->>'status' = 'active'`;
for (const salon of salons) {
  const [branch] = await sql`SELECT id, record FROM app_records WHERE collection = 'branches' AND record->>'salonId' = ${salon.id} AND record->>'status' = 'active' ORDER BY created_at ASC LIMIT 1`;
  if (!branch) continue;
  const branchName = String((branch.record as any)?.name || 'Main Branch');
  await sql`
    UPDATE app_records
    SET record = record || ${JSON.stringify({ branchId: branch.id, branchName })}::jsonb
    WHERE tenant_id = ${salon.id}
      AND collection NOT IN ('salons', 'branches', 'accounts', 'sessions')
      AND (record->>'branchId' IS NULL OR record->>'branchId' = '')
  `;
  console.log(`Migrated legacy records for ${salon.id} to ${branchName} (${branch.id}).`);
}
