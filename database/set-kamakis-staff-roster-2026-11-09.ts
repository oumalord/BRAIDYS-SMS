import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomBytes, randomInt, randomUUID, scryptSync } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const expectedConfirmation = 'SET_EXACT_KAMAKIS_ROSTER';
const execute = process.env.CONFIRM_KAMAKIS_ROSTER === expectedConfirmation;
const roster = [
  { name: 'Cliff', phone: '0746328059', role: 'Staff' },
  { name: 'Glady', phone: '0113586001', role: 'Staff' },
  { name: 'Dan', phone: '0726944510', role: 'Receptionist', needsAccount: true },
  { name: 'Nancy', phone: '0140121989', role: 'Cleaner' },
  { name: 'Eva', phone: '0114557858', role: 'Staff' },
  { name: 'Shiko', phone: '0708367985', role: 'Staff' },
  { name: 'Ivy', phone: '0781559697', role: 'Receptionist', needsAccount: true },
  { name: 'Kanini', phone: '0745432579', role: 'Staff' },
  { name: 'Pk.', phone: '0706451166', role: 'Staff' },
  { name: 'Liz', phone: '0700681477', role: 'Staff' },
  { name: 'Sofi', phone: '0715715120', role: 'Staff' },
  { name: 'Mary', phone: '0790042832', role: 'Staff' },
  { name: 'Jasmin', phone: '0112195942', role: 'Staff' },
] as const;

type Row = { id: string; record: Record<string, any> };
const normalizePhone = (value: unknown) => String(value || '').replace(/\D/g, '');
const normalizeName = (value: unknown) => String(value || '').trim().toLowerCase();
const hashPin = (pin: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 64).toString('hex')}`;
};

const branches = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'branches' AND lower(record->>'name') LIKE '%kamakis%'
    AND record->>'status' = 'active'
` as Row[];
if (branches.length !== 1) throw new Error(`Expected one active Kamakis branch; found ${branches.length}`);
const branch = branches[0];
const tenantId = String(branch.record.salonId || '');
if (!tenantId) throw new Error('Kamakis branch is missing its salonId');
const [salon] = await sql`SELECT id, record FROM app_records WHERE collection = 'salons' AND id = ${tenantId}` as Row[];
if (!salon) throw new Error('Kamakis salon was not found');

const [staffRows, accountRows, retainedCounts] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})` as Promise<Row[]>,
  sql`SELECT id, record FROM app_records WHERE collection = 'accounts'` as Promise<Row[]>,
  sql`SELECT collection, COUNT(*)::int AS count FROM app_records WHERE collection IN ('attendance', 'services') GROUP BY collection` as Promise<{ collection: string; count: number }[]>,
]);

const staffMatches = new Map<string, Row>();
const accountMatches = new Map<string, Row>();
const targetPhones = new Set(roster.map(person => normalizePhone(person.phone)));
const conflicts: string[] = [];

for (const person of roster) {
  const phone = normalizePhone(person.phone);
  const phoneMatches = staffRows.filter(row => normalizePhone(row.record.phone) === phone);
  const nameMatches = staffRows.filter(row => row.record.branchId === branch.id
    && !row.record.deletedAt && normalizeName(row.record.name) === normalizeName(person.name));
  const matches = phoneMatches.length ? phoneMatches : nameMatches;
  if (matches.length > 1) conflicts.push(`${person.name}: multiple staff records use ${person.phone}`);
  if (matches.length === 1) staffMatches.set(phone, matches[0]);

  const staffId = matches.length === 1 ? matches[0].id : '';
  const matchingAccounts = accountRows.filter(row => row.record.staffId === staffId && staffId
    || normalizePhone(row.record.phone) === phone
    || (!staffId && row.record.branchId === branch.id && normalizeName(row.record.name) === normalizeName(person.name)));
  if (matchingAccounts.length > 1) conflicts.push(`${person.name}: multiple accounts use ${person.phone}`);
  if (matchingAccounts.length === 1) {
    const account = matchingAccounts[0];
    if (['owner', 'admin', 'customer'].includes(String(account.record.role || '').toLowerCase())) {
      conflicts.push(`${person.name}: ${person.phone} belongs to a non-staff account`);
    } else {
      accountMatches.set(phone, account);
    }
  } else if (person.needsAccount && accountRows.some(row => normalizePhone(row.record.phone) === phone)) {
    conflicts.push(`${person.name}: ${person.phone} is already assigned to another account`);
  }
}

if (conflicts.length) throw new Error(`Roster conflicts need manual resolution: ${conflicts.join('; ')}`);

const targetStaffIds = new Set(Array.from(staffMatches.values(), row => row.id));
const activeKamakisStaff = staffRows.filter(row => String(row.record.branchId || '') === branch.id && !row.record.deletedAt);
const staffToRetire = activeKamakisStaff.filter(row => !targetStaffIds.has(row.id));
const accountsToDisable = accountRows.filter(row => {
  const role = String(row.record.role || '').toLowerCase();
  if (['owner', 'admin', 'customer'].includes(role)) return false;
  return (row.record.branchId === branch.id || staffToRetire.some(staff => staff.id === row.record.staffId))
    && !Array.from(accountMatches.values()).some(match => match.id === row.id);
});

const newStaff = roster.filter(person => !staffMatches.has(normalizePhone(person.phone)));
const newReceptionistAccounts = roster.filter(person => person.needsAccount && !accountMatches.has(normalizePhone(person.phone)));
console.log(JSON.stringify({
  mode: execute ? 'execute' : 'dry-run',
  branch: { id: branch.id, name: branch.record.name },
  roster,
  existingStaffMatches: roster.filter(person => staffMatches.has(normalizePhone(person.phone))).map(person => person.name),
  staffToAdd: newStaff.map(person => person.name),
  staffToRetire: staffToRetire.map(row => ({ id: row.id, name: row.record.name, phone: row.record.phone })),
  activeKamakisStaffBefore: activeKamakisStaff.map(row => ({ id: row.id, name: row.record.name, phone: row.record.phone, employmentStatus: row.record.employmentStatus })),
  existingAccountsToRetainOrUpdate: roster.flatMap(person => {
    const account = accountMatches.get(normalizePhone(person.phone));
    return account ? [{ name: person.name, hasCredential: Boolean(account.record.passwordHash || account.record.pinHash) }] : [];
  }),
  receptionistAccountsToCreate: newReceptionistAccounts.map(person => person.name),
  accountsToDisable: accountsToDisable.map(row => ({ id: row.id, name: row.record.name, phone: row.record.phone, role: row.record.role, branchId: row.record.branchId })),
  attendanceAndServicesCounts: retainedCounts,
}, null, 2));

if (!execute) {
  console.log(`Dry run only. Set CONFIRM_KAMAKIS_ROSTER=${expectedConfirmation} to apply.`);
  process.exit(0);
}

const now = Date.now();
const staffIdByPhone = new Map<string, string>();
for (const person of roster) {
  const phone = normalizePhone(person.phone);
  const existing = staffMatches.get(phone);
  const staffId = existing?.id || `staff-${randomUUID()}`;
  const record: Record<string, any> = {
    ...(existing?.record || {}),
    id: staffId,
    tenantId,
    salonName: salon.record.name,
    branchId: branch.id,
    branchName: branch.record.name,
    branch: branch.record.name,
    name: person.name,
    role: person.role,
    specialties: existing?.record.specialties || [],
    chair: existing?.record.chair || '',
    phone: person.phone,
    commissionPct: existing?.record.commissionPct ?? 50,
    employmentStatus: 'active',
    accountStatus: person.needsAccount ? 'active' : (existing?.record.accountStatus || 'pending'),
    status: 'available',
    createdAt: existing?.record.createdAt || now,
  };
  delete record.deletedAt;
  delete record.deletedBy;
  if (existing) {
    await sql`UPDATE app_records SET record = ${JSON.stringify(record)}::jsonb, tenant_id = ${tenantId} WHERE id = ${existing.id} AND collection = 'staff'`;
  } else {
    await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${staffId}, 'staff', ${tenantId}, ${JSON.stringify(record)}::jsonb)`;
  }
  staffIdByPhone.set(phone, staffId);
}

for (const person of roster) {
  const phone = normalizePhone(person.phone);
  const staffId = staffIdByPhone.get(phone)!;
  const existing = accountMatches.get(phone);
  if (!existing && !person.needsAccount) continue;
  const hasCredential = Boolean(existing?.record.passwordHash || existing?.record.pinHash);
  const pin = person.needsAccount && !hasCredential ? String(randomInt(1000, 10000)) : '';
  const accountId = existing?.id || `account-${randomUUID()}`;
  const record: Record<string, any> = {
    ...(existing?.record || {}),
    id: accountId,
    tenantId,
    salonName: salon.record.name,
    branchId: branch.id,
    name: person.name,
    phone: person.phone,
    role: person.needsAccount ? 'receptionist' : existing?.record.role,
    status: 'active',
    staffId,
    createdAt: existing?.record.createdAt || now,
  };
  if (pin) record.pinHash = hashPin(pin);
  delete record.deletedAt;
  delete record.deletedBy;
  if (existing) {
    await sql`UPDATE app_records SET record = ${JSON.stringify(record)}::jsonb WHERE id = ${existing.id} AND collection = 'accounts'`;
  } else {
    await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${accountId}, 'accounts', NULL, ${JSON.stringify(record)}::jsonb)`;
  }
  if (pin) console.log(`Temporary PIN for ${person.name}: ${pin}`);
}

for (const row of staffToRetire) {
  const record = {
    ...row.record,
    deletedAt: now,
    deletedBy: 'Kamakis roster reset',
    employmentStatus: 'permanently-deleted',
    status: 'off',
    accountStatus: 'disabled',
  };
  await sql`UPDATE app_records SET record = ${JSON.stringify(record)}::jsonb WHERE id = ${row.id} AND collection = 'staff'`;
}

for (const row of accountsToDisable) {
  const record = { ...row.record, status: 'disabled', accountStatus: 'disabled' };
  await sql`UPDATE app_records SET record = ${JSON.stringify(record)}::jsonb WHERE id = ${row.id} AND collection = 'accounts'`;
}

const [activeAfter, retainedAfter] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND tenant_id = ${tenantId} AND record->>'branchId' = ${branch.id} AND NOT (record ? 'deletedAt')` as Promise<Row[]>,
  sql`SELECT collection, COUNT(*)::int AS count FROM app_records WHERE collection IN ('attendance', 'services') GROUP BY collection` as Promise<{ collection: string; count: number }[]>,
]);
const activePhones = new Set(activeAfter.map(row => normalizePhone(row.record.phone)));
const expectedPhones = new Set(roster.map(person => normalizePhone(person.phone)));
const unchangedRetainedCounts = JSON.stringify([...retainedCounts].sort((a, b) => a.collection.localeCompare(b.collection)))
  === JSON.stringify([...retainedAfter].sort((a, b) => a.collection.localeCompare(b.collection)));
console.log(JSON.stringify({
  result: 'complete',
  activeKamakisStaff: activeAfter.map(row => ({ name: row.record.name, phone: row.record.phone, role: row.record.role })),
  correctRoster: activeAfter.length === roster.length && expectedPhones.size === activePhones.size && [...expectedPhones].every(phone => activePhones.has(phone)),
  attendanceAndServicesUnchanged: unchangedRetainedCounts,
}, null, 2));
if (activeAfter.length !== roster.length || expectedPhones.size !== activePhones.size || ![...expectedPhones].every(phone => activePhones.has(phone)) || !unchangedRetainedCounts) {
  throw new Error('Kamakis roster verification failed');
}