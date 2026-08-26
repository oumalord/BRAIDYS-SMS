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

const people = [
  ['Ann', '0725202635'],
  ['Lilian', '0723278950'],
  ['Caro', '0721918268'],
  ['Mbugua', '0748039767'],
  ['Salma', '0718627235'],
  ['Eliza', '0796423612'],
  ['Dorothy', '0141942523'],
  ['Brenda', '0714698489'],
] as const;

const [salon] = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'salons' AND upper(record->>'name') = 'BRAIDYS'
  LIMIT 1
` as any[];
if (!salon) throw new Error('BRAIDYS salon was not found');

const [branch] = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'branches'
    AND record->>'salonId' = ${salon.id}
    AND lower(record->>'name') LIKE '%main%'
    AND record->>'status' = 'active'
  LIMIT 1
` as any[];
if (!branch) throw new Error('BRAIDYS Main Branch was not found');

const tenantId = salon.id;
const branchRecord = branch.record as any;

const existingStaff = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'staff' AND tenant_id = ${tenantId}
` as any[];
const existingAccounts = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'accounts' AND record->>'tenantId' = ${tenantId}
` as any[];

const existingStaffKeys = new Set(
  existingStaff.map(row => `${String(row.record?.name || '').trim().toLowerCase()}|${String(row.record?.phone || '').replace(/\s+/g, '')}`),
);
const existingPhones = new Set(
  existingAccounts.map(row => String(row.record?.phone || '').replace(/\s+/g, '')),
);

let createdStaff = 0;
let createdAccounts = 0;
let retained = 0;

for (const [name, rawPhone] of people) {
  const phone = rawPhone.replace(/\s+/g, '');
  const staffKey = `${name.trim().toLowerCase()}|${phone}`;

  if (existingStaffKeys.has(staffKey) || existingPhones.has(phone)) {
    retained++;
    continue;
  }

  const staffId = `staff-${randomUUID()}`;
  const staffRecord = {
    id: staffId,
    tenantId,
    salonName: salon.record.name,
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
  createdStaff++;

  const accountId = `account-${randomUUID()}`;
  const accountRecord = {
    id: accountId,
    tenantId,
    salonName: salon.record.name,
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
  createdAccounts++;

  existingStaffKeys.add(staffKey);
  existingPhones.add(phone);
}

console.log(`Branch: ${branchRecord.name}`);
console.log(`Created ${createdStaff} staff records and ${createdAccounts} phone/PIN accounts.`);
console.log(`Retained ${retained} existing records (already present).`);
console.log(`Temporary PIN for newly created accounts: ${temporaryPin}`);
