import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const expectedConfirmation = 'CREATE_NANCY_KAMAKIS_LOGIN';
const execute = process.env.CONFIRM_NANCY_KAMAKIS_LOGIN === expectedConfirmation;
const defaultPin = '1234';
const normalizePhone = (value: unknown) => String(value || '').replace(/\D/g, '');
const hashPin = (pin: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 64).toString('hex')}`;
};

const [branch] = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'branches' AND lower(record->>'name') LIKE '%kamakis%'
    AND record->>'status' = 'active'
` as any[];
if (!branch) throw new Error('Active Kamakis branch was not found');

const staffRows = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'staff' AND tenant_id = ${branch.record.salonId}
` as any[];
const staffMatches = staffRows.filter(row => row.record.branchId === branch.id
  && String(row.record.name || '').trim().toLowerCase() === 'nancy'
  && !row.record.deletedAt && row.record.employmentStatus === 'active');
if (staffMatches.length !== 1) throw new Error(`Expected one active Nancy profile at Kamakis; found ${staffMatches.length}`);
const staff = staffMatches[0];
const phone = String(staff.record.phone || '').trim();
if (!normalizePhone(phone)) throw new Error('Nancy’s staff profile has no valid phone number');

const accountRows = await sql`SELECT id, record FROM app_records WHERE collection = 'accounts'` as any[];
const linkedAccounts = accountRows.filter(row => row.record.staffId === staff.id);
if (linkedAccounts.length > 1) throw new Error(`Nancy has ${linkedAccounts.length} linked accounts; resolve duplicates manually`);
const existing = linkedAccounts[0];
const phoneConflict = accountRows.find(row => normalizePhone(row.record.phone) === normalizePhone(phone)
  && row.record.id !== existing?.id);
if (phoneConflict) throw new Error(`Nancy’s current phone is already assigned to another account (${phoneConflict.record.name || phone})`);

const accountId = existing?.id || `account-${randomUUID()}`;
const record = {
  ...(existing?.record || {}),
  id: accountId,
  tenantId: branch.record.salonId,
  salonName: branch.record.salonName || 'BRAIDYS',
  branchId: branch.id,
  name: staff.record.name,
  email: String(staff.record.accountEmail || existing?.record.email || '').trim().toLowerCase(),
  phone,
  role: existing?.record.role || (String(staff.record.role || '').toLowerCase().includes('reception') ? 'receptionist' : 'barber'),
  status: 'active',
  staffId: staff.id,
  pinHash: existing?.record.pinHash || hashPin(defaultPin),
  createdAt: existing?.record.createdAt || Date.now(),
};

console.log(JSON.stringify({
  mode: execute ? 'execute' : 'dry-run',
  staff: staff.record.name,
  phone,
  branch: branch.record.name,
  accountAction: existing ? 'activate and sync phone' : 'create login with default PIN',
}, null, 2));

if (!execute) {
  console.log(`Dry run only. Set CONFIRM_NANCY_KAMAKIS_LOGIN=${expectedConfirmation} to apply.`);
  process.exit(0);
}

if (existing) {
  await sql`UPDATE app_records SET record = ${JSON.stringify(record)}::jsonb WHERE id = ${accountId} AND collection = 'accounts'`;
} else {
  await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${accountId}, 'accounts', ${branch.record.salonId}, ${JSON.stringify(record)}::jsonb)`;
}
await sql`UPDATE app_records SET record = ${JSON.stringify({ ...staff.record, accountStatus: 'active' })}::jsonb WHERE id = ${staff.id} AND collection = 'staff'`;

const [verified] = await sql`SELECT id, record FROM app_records WHERE collection = 'accounts' AND id = ${accountId}` as any[];
const [salt, expectedHash] = String(verified?.record?.pinHash || '').split(':');
const defaultPinAccepted = Boolean(salt && expectedHash && timingSafeEqual(scryptSync(defaultPin, salt, 64), Buffer.from(expectedHash, 'hex')));
if (!verified || verified.record.status !== 'active' || normalizePhone(verified.record.phone) !== normalizePhone(phone)
  || verified.record.staffId !== staff.id || (!existing && !defaultPinAccepted)) {
  throw new Error('Nancy login verification failed');
}
console.log(JSON.stringify({ result: 'complete', accountId, active: true, phoneUpdated: true, linkedToStaff: true, defaultPinAccepted }));