import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const salonId = process.argv[2];
if (!salonId) throw new Error('Usage: npm run db:clone-branch -- <salon-id>');

const collections = [
  'staff', 'services', 'customers', 'products', 'appointments', 'queue', 'orders',
  'expenses', 'membership_plans', 'membership_purchases', 'promotions', 'reviews',
  'messages', 'mpesa_transactions', 'notifications', 'stock_movements',
];

type Row = { id: string; record: Record<string, any> };
function replaceIds(value: any, ids: Map<string, string>): any {
  if (typeof value === 'string') return ids.get(value) || value;
  if (Array.isArray(value)) return value.map(item => replaceIds(item, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceIds(item, ids)]));
  return value;
}

const branches = await sql`SELECT id, record FROM app_records WHERE collection = 'branches' AND record->>'salonId' = ${salonId} AND record->>'status' = 'active' ORDER BY created_at ASC` as { id: string; record: Record<string, any> }[];
if (branches.length < 2) { console.log('No secondary branch requires cloning.'); process.exit(0); }
const source = branches[0];

for (const target of branches.slice(1)) {
  let cloned = 0;
  for (const collection of collections) {
    const sourceRows = await sql`SELECT id, record FROM app_records WHERE tenant_id = ${salonId} AND collection = ${collection} AND record->>'branchId' = ${source.id} ORDER BY created_at ASC` as Row[];
    if (!sourceRows.length) continue;
    const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM app_records WHERE tenant_id = ${salonId} AND collection = ${collection} AND record->>'branchId' = ${target.id}` as { count: number }[];
    if (count > 0) continue;

    const idMap = new Map(sourceRows.map(row => [row.id, `${collection}-${randomUUID()}`]));
    for (const row of sourceRows) {
      const id = idMap.get(row.id)!;
      const record = replaceIds({ ...row.record, id, branchId: target.id, branchName: target.record.name, tenantId: salonId }, idMap);
      await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${id}, ${collection}, ${salonId}, ${JSON.stringify(record)}::jsonb)`;
      cloned++;
    }
  }
  console.log(`Cloned ${cloned} records from ${source.record.name} to ${target.record.name}.`);
}
