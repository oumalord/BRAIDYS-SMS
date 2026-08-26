import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const sql = neon(databaseUrl);

const [salon] = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'salons' AND upper(record->>'name') = 'BRAIDYS'
  LIMIT 1
` as any[];
if (!salon) throw new Error('BRAIDYS salon not found');

const [branch] = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'branches'
    AND record->>'salonId' = ${salon.id}
    AND lower(record->>'name') LIKE '%main%'
    AND record->>'status' = 'active'
  LIMIT 1
` as any[];
if (!branch) throw new Error('Main branch not found');

const requestedNames = [
  'Lydia', 'Hellen', 'Megan', 'Josphine', 'Muthoni', 'Naomi', 'Agnes', 'Pauline',
  'Adolphine', 'Angela', 'Keziah', 'Mercy', 'Nyambura', 'Emily', 'Akisa', 'Njeru',
  'Tifa', 'Grace', 'Palenda', 'Wanjiru', 'Kabi', 'Triza', 'Diana', 'Faith',
  'Millicent', 'Alice',
];

const rows = await sql`
  SELECT record->>'name' AS name, record->>'phone' AS phone
  FROM app_records
  WHERE collection = 'staff'
    AND tenant_id = ${salon.id}
    AND record->>'branchId' = ${branch.id}
    AND record->>'name' = ANY(${requestedNames})
  ORDER BY record->>'name' ASC
` as { name: string; phone: string }[];

const staffAccounts = await sql`
  SELECT COUNT(*)::int AS count
  FROM app_records
  WHERE collection = 'accounts'
    AND record->>'staffId' <> ''
    AND record->>'role' = ANY(${['barber', 'receptionist']})
    AND coalesce(record->>'pinChangedAt', '') = ''
` as { count: number }[];

const operational = await sql`
  SELECT collection, COUNT(*)::int AS count
  FROM app_records
  WHERE collection <> ALL(${['salons', 'branches', 'accounts', 'staff']})
  GROUP BY collection
  ORDER BY collection ASC
` as { collection: string; count: number }[];

console.log(JSON.stringify({
  branch: branch.record.name,
  confirmedStaffCount: rows.length,
  staff: rows,
  staffPinForcedChangeCount: staffAccounts[0]?.count || 0,
  remainingOperationalCollections: operational,
}, null, 2));
