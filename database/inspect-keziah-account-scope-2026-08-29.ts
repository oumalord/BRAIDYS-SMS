import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const accounts = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'accounts' AND lower(record->>'name') = 'keziah'
` as { id: string; record: any }[];
const staff = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'staff' AND lower(record->>'name') = 'keziah'
` as { id: string; record: any }[];
const branches = await sql`SELECT id, record FROM app_records WHERE collection = 'branches'` as { id: string; record: any }[];
const results: any[] = [];
for (const account of accounts) {
  const tenantId = String(account.record?.tenantId || '');
  const branchId = String(account.record?.branchId || '');
  const scoped = await Promise.all(['services', 'customers', 'appointments', 'products', 'queue', 'orders'].map(async collection => {
    const rows = await sql`SELECT id FROM app_records WHERE collection = ${collection} AND tenant_id = ${tenantId} AND record->>'branchId' = ${branchId}` as { id: string }[];
    return [collection, rows.length];
  }));
  results.push({ account: { id: account.id, name: account.record?.name, phone: account.record?.phone, role: account.record?.role, tenantId, branchId, staffId: account.record?.staffId }, visibleCounts: Object.fromEntries(scoped) });
}
console.log(JSON.stringify({ accounts: results, staff: staff.map(member => ({ id: member.id, name: member.record?.name, phone: member.record?.phone, tenantId: member.record?.tenantId, branchId: member.record?.branchId })), branches: branches.map(branch => ({ id: branch.id, name: branch.record?.name, salonId: branch.record?.salonId, status: branch.record?.status })) }, null, 2));