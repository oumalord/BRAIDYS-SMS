import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const temporaryPin = '1234';

function passwordHash(value: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}

const staff = [
  ['Liz', '0700681477'],
  ['Wacona', '0114891484'],
  ['Rasta', '0112233273'],
  ['Picy', '0706451160'],
  ['Sofia', '0715775120'],
  ['Shiko', '0708367985'],
  ['Mary', '0790042833'],
  ['Cate', '0745432579'],
] as const;

const [branch] = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'branches'
    AND lower(record->>'name') LIKE '%kamakis%'
    AND record->>'status' = 'active'
  LIMIT 1
` as any[];
if (!branch) throw new Error('Kamakis branch was not found');

const branchRecord = branch.record as any;
const tenantId = branchRecord.salonId;
const accounts = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'accounts' AND record->>'tenantId' = ${tenantId}
` as any[];
const existingPhones = new Set(accounts.map(row => String(row.record?.phone || '').replace(/\s+/g, '')));
const existingStaff = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'staff' AND tenant_id = ${tenantId}
` as any[];
const existingStaffKeys = new Set(existingStaff.map(row => `${row.record?.name}|${row.record?.phone || ''}`));

let created = 0;
let retained = 0;
for (const [name, phone] of staff) {
  const key = `${name}|${phone}`;
  if (existingStaffKeys.has(key) || existingPhones.has(phone)) {
    retained++;
    continue;
  }

  const staffId = `staff-${randomUUID()}`;
  const staffRecord = {
    id: staffId,
    tenantId,
    salonName: branchRecord.salonName || '',
    branchId: branch.id,
    branchName: branchRecord.name,
    name,
    role: 'Staff',
    specialties: [],
    branch: branchRecord.name,
    chair: '',
    phone,
    commissionPct: 50,
    employmentStatus: 'active',
    accountStatus: 'active',
    status: 'available',
    createdAt: Date.now(),
  };
  await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${staffId}, 'staff', ${tenantId}, ${JSON.stringify(staffRecord)}::jsonb)`;

  const accountId = `account-${randomUUID()}`;
  const accountRecord = {
    id: accountId,
    tenantId,
    salonName: branchRecord.salonName || '',
    branchId: branch.id,
    name,
    email: '',
    phone,
    role: 'barber',
    status: 'active',
    pinHash: passwordHash(temporaryPin),
    staffId,
    createdAt: Date.now(),
  };
  await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${accountId}, 'accounts', ${tenantId}, ${JSON.stringify(accountRecord)}::jsonb)`;
  existingStaffKeys.add(key);
  existingPhones.add(phone);
  created++;
}

console.log(`Kamakis branch: ${branchRecord.name}`);
console.log(`Created ${created} staff accounts; retained ${retained} existing records.`);
console.log(`Temporary PIN for newly created accounts: ${temporaryPin}`);
console.log('Ivy was not changed.');
