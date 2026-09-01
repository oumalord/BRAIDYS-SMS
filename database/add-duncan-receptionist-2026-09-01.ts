import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const name = 'Duncan';
const phone = '0795115650';
const pin = '1234';

function pinHash(value: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}

const [salon] = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'salons' AND upper(record->>'name') = 'BRAIDYS'
  LIMIT 1
` as any[];
if (!salon) throw new Error('BRAIDYS salon was not found');

const [branch] = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'branches'
    AND record->>'salonId' = ${salon.id}
    AND lower(record->>'name') LIKE '%main%'
    AND record->>'status' = 'active'
  LIMIT 1
` as any[];
if (!branch) throw new Error('BRAIDYS Main Branch was not found');

const [existingStaff] = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'staff' AND tenant_id = ${salon.id}
    AND replace(record->>'phone', ' ', '') = ${phone}
  LIMIT 1
` as any[];

const staffId = existingStaff?.id || `staff-${randomUUID()}`;
const staffRecord = {
  ...(existingStaff?.record || {}),
  id: staffId,
  tenantId: salon.id,
  salonName: salon.record.name,
  branchId: branch.id,
  branchName: branch.record.name,
  name,
  role: 'Receptionist',
  specialties: existingStaff?.record?.specialties || [],
  branch: branch.record.name,
  chair: existingStaff?.record?.chair || '',
  phone,
  commissionPct: 50,
  employmentStatus: 'active',
  accountStatus: 'active',
  status: existingStaff?.record?.status || 'available',
  createdAt: existingStaff?.record?.createdAt || Date.now(),
};

if (existingStaff) {
  await sql`UPDATE app_records SET record = ${JSON.stringify(staffRecord)}::jsonb WHERE id = ${staffId}`;
} else {
  await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${staffId}, 'staff', ${salon.id}, ${JSON.stringify(staffRecord)}::jsonb)`;
}

const [existingAccount] = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'accounts'
    AND (record->>'staffId' = ${staffId} OR replace(record->>'phone', ' ', '') = ${phone})
  LIMIT 1
` as any[];

const accountId = existingAccount?.id || `account-${randomUUID()}`;
const accountRecord = {
  ...(existingAccount?.record || {}),
  id: accountId,
  tenantId: salon.id,
  salonName: salon.record.name,
  branchId: branch.id,
  name,
  email: existingAccount?.record?.email || '',
  phone,
  role: 'receptionist',
  status: 'active',
  pinHash: pinHash(pin),
  staffId,
  createdAt: existingAccount?.record?.createdAt || Date.now(),
};
delete accountRecord.passwordHash;

if (existingAccount) {
  await sql`UPDATE app_records SET record = ${JSON.stringify(accountRecord)}::jsonb WHERE id = ${accountId}`;
} else {
  await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${accountId}, 'accounts', ${salon.id}, ${JSON.stringify(accountRecord)}::jsonb)`;
}

console.log(`${existingStaff ? 'Updated' : 'Added'} ${name} as BRAIDYS Main receptionist.`);
console.log(`Login phone: ${phone}; temporary PIN: ${pin}`);