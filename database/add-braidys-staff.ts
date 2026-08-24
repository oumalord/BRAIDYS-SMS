import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomBytes, scryptSync, randomUUID } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const pin = '1234';
const adminEmail = 'sirlordphick@gmail.com';
const adminPassword = 'Lord9632@@';

function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

const staff = [
  ['Diana', '0748921947', 'receptionist'],
  ['Beth', '07456313257', 'receptionist'],
  ['Steve', '', 'staff'],
  ['Yulie', '0797868442', 'staff'],
  ['Helen', '0711321199', 'staff'],
  ['Megan', '0757219272', 'staff'],
  ['Maureen', '0745591444', 'staff'],
  ['Josephine', '0703739242', 'staff'],
  ['Mumoni', '0759548641', 'staff'],
  ['Naomi', '0116372148', 'staff'],
  ['Agnes', '0799328414', 'staff'],
  ['Pauline', '07901069228', 'staff'],
  ['Adolphine', '0706713659', 'staff'],
  ['Angela', '0728156065', 'staff'],
  ['Keziah', '0769165908', 'staff'],
  ['Mercy', '0703774050', 'staff'],
  ['Nyambura', '0710367189', 'staff'],
  ['Emily', '0726842243', 'staff'],
  ['Akisa', '0790585672', 'staff'],
  ['Njeri', '0704914112', 'staff'],
  ['Tiya', '0759243562', 'staff'],
  ['Grace', '0768970415', 'staff'],
  ['Palencia', '0703540925', 'staff'],
  ['Klongivu', '0794990402', 'staff'],
  ['Kabi', '074653121', 'staff'],
  ['Triza', '0111952328', 'staff'],
  ['Diana', '0794705370', 'staff'],
  ['Faith', '0740667333', 'staff'],
  ['Millicent', '0747298144', 'staff'],
  ['Alice', '0704671501', 'staff'],
] as const;

const [salon] = await sql`SELECT id, record FROM app_records WHERE collection = 'salons' AND upper(record->>'name') = 'BRAIDYS' LIMIT 1` as any[];
if (!salon) throw new Error('BRAIDYS salon was not found');
const [branch] = await sql`SELECT id, record FROM app_records WHERE collection = 'branches' AND record->>'salonId' = ${salon.id} AND lower(record->>'name') LIKE '%main%' LIMIT 1` as any[];
if (!branch) throw new Error('BRAIDYS Main Branch was not found');

const accounts = await sql`SELECT id, record FROM app_records WHERE collection = 'accounts' AND record->>'tenantId' = ${salon.id}` as any[];
const existingStaff = await sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND tenant_id = ${salon.id}` as any[];
const existingPhones = new Set(accounts.map(row => String(row.record?.phone || '').replace(/\s+/g, '')));
const existingStaffKeys = new Set(existingStaff.map(row => `${row.record?.name}|${row.record?.phone || ''}`));

for (const [name, phone, accountRole] of staff) {
  const key = `${name}|${phone}`;
  if (existingStaffKeys.has(key)) continue;
  const staffId = `staff-${randomUUID()}`;
  const staffRecord = {
    id: staffId, tenantId: salon.id, salonName: salon.record.name, branchId: branch.id, branchName: branch.record.name,
    name, role: accountRole === 'receptionist' ? 'Receptionist' : 'Staff', specialties: [], branch: branch.record.name,
    chair: '', phone, commissionPct: 50, employmentStatus: 'active', accountStatus: phone ? 'active' : 'pending', status: 'available', createdAt: Date.now(),
  };
  await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${staffId}, 'staff', ${salon.id}, ${JSON.stringify(staffRecord)}::jsonb)`;
  existingStaffKeys.add(key);

  const normalizedPhone = phone.replace(/\s+/g, '');
  if (normalizedPhone && !existingPhones.has(normalizedPhone)) {
    const accountId = `account-${randomUUID()}`;
    const accountRecord = {
      id: accountId, tenantId: salon.id, salonName: salon.record.name, branchId: branch.id, name, email: '', phone,
      role: accountRole === 'receptionist' ? 'receptionist' : 'barber', status: 'active', pinHash: passwordHash(pin), staffId, createdAt: Date.now(),
    };
    await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${accountId}, 'accounts', NULL, ${JSON.stringify(accountRecord)}::jsonb)`;
    existingPhones.add(normalizedPhone);
  }
}

const adminId = 'account-platform-admin';
const [existingAdmin] = await sql`SELECT id, record FROM app_records WHERE id = ${adminId} AND collection = 'accounts'` as any[];
const adminRecord = { id: adminId, tenantId: 'platform', salonName: 'All Salons', branchId: '', name: 'Platform Admin', email: adminEmail, phone: '', role: 'admin', status: 'active', passwordHash: passwordHash(adminPassword), createdAt: existingAdmin?.record?.createdAt || Date.now() };
if (existingAdmin) await sql`UPDATE app_records SET record = ${JSON.stringify(adminRecord)}::jsonb, tenant_id = NULL WHERE id = ${adminId} AND collection = 'accounts'`;
else await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${adminId}, 'accounts', NULL, ${JSON.stringify(adminRecord)}::jsonb)`;

console.log(`Added or retained ${staff.length} BRAIDYS Main Branch staff records.`);
console.log(`Created or retained ${staff.filter(item => item[1]).length} phone/PIN employee accounts.`);
console.log('Steve was added as staff but has no phone-login account because no phone number was provided.');
console.log(`Admin login: ${adminEmail} / ${adminPassword}`);
