import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const retainedCollections = [
  'salons',
  'branches',
  'staff',
  'services',
  'products',
  'accounts',
  'customers',
  'attendance',
  'audit_logs',
  'complaints',
  'sessions',
  'membership_plans',
  'promotions',
];
const branches = await sql`
  SELECT id, record->>'name' AS name
  FROM app_records
  WHERE collection = 'branches'
  ORDER BY record->>'name'
` as { id: string; name: string | null }[];
const accountRoles = await sql`
  SELECT COALESCE(record->>'role', 'unknown') AS role, COUNT(*)::int AS count
  FROM app_records
  WHERE collection = 'accounts'
  GROUP BY record->>'role'
  ORDER BY record->>'role'
` as { role: string; count: number }[];
const countsBefore = await sql`
  SELECT collection, COUNT(*)::int AS count
  FROM app_records
  GROUP BY collection
  ORDER BY collection
` as { collection: string; count: number }[];
const toRemove = countsBefore.filter(row => !retainedCollections.includes(row.collection));

console.log(JSON.stringify({
  mode: process.env.CONFIRM_FRESH_START === 'DELETE_OPERATIONAL_AND_FINANCIAL_HISTORY' ? 'execute' : 'dry-run',
  branches,
  retainedAccountsByRole: accountRoles,
  retainedCollections,
  retainedRecords: countsBefore.filter(row => retainedCollections.includes(row.collection)),
  collectionsToDelete: toRemove,
  recordsToDelete: toRemove.reduce((sum, row) => sum + row.count, 0),
  customerProfilesToReset: countsBefore.find(row => row.collection === 'customers')?.count || 0,
}, null, 2));

if (process.env.CONFIRM_FRESH_START !== 'DELETE_OPERATIONAL_AND_FINANCIAL_HISTORY') {
  console.log('Dry run only. Set CONFIRM_FRESH_START=DELETE_OPERATIONAL_AND_FINANCIAL_HISTORY to apply this reset.');
  process.exit(0);
}

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
try {
  await sql`DELETE FROM app_records WHERE collection <> ALL(${retainedCollections})`;
  await sql`
    UPDATE app_records
    SET record = record || '{"loyaltyPoints":0,"totalSpent":0,"totalSpentUSD":0,"visits":0,"lastVisit":null}'::jsonb
    WHERE collection = 'customers'
  `;
  await sql`
    UPDATE app_records
    SET record = record || '{"status":"available"}'::jsonb
    WHERE collection = 'staff'
      AND NOT (record ? 'deletedAt')
      AND record->>'employmentStatus' IS DISTINCT FROM 'permanently-deleted'
      AND record->>'status' IS DISTINCT FROM 'available'
  `;
} finally {
  await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
  await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
}

const countsAfter = await sql`
  SELECT collection, COUNT(*)::int AS count
  FROM app_records
  GROUP BY collection
  ORDER BY collection
` as { collection: string; count: number }[];
const remainingOperationalRecords = countsAfter.filter(row => !retainedCollections.includes(row.collection));
const [{ activeAppointments }] = await sql`
  SELECT COUNT(*)::int AS "activeAppointments"
  FROM app_records
  WHERE collection = 'appointments' AND NOT (record ? 'deletedAt')
` as { activeAppointments: number }[];
const [{ nonZeroCustomerTotals }] = await sql`
  SELECT COUNT(*)::int AS "nonZeroCustomerTotals"
  FROM app_records
  WHERE collection = 'customers'
    AND (
      COALESCE((record->>'loyaltyPoints')::numeric, 0) <> 0
      OR COALESCE((record->>'totalSpent')::numeric, 0) <> 0
      OR COALESCE((record->>'totalSpentUSD')::numeric, 0) <> 0
      OR COALESCE((record->>'visits')::numeric, 0) <> 0
      OR record->'lastVisit' IS NOT NULL AND record->'lastVisit' <> 'null'::jsonb
    )
` as { nonZeroCustomerTotals: number }[];

console.log(JSON.stringify({
  result: 'complete',
  remainingCollections: countsAfter,
  remainingOperationalRecords,
  activeAppointments,
  nonZeroCustomerTotals,
}, null, 2));

if (remainingOperationalRecords.length || activeAppointments || nonZeroCustomerTotals) {
  throw new Error('Fresh-start verification failed');
}