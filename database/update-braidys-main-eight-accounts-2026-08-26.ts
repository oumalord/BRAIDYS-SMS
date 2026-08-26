import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);

type Target = {
  name: string;
  phone: string;
  aliases: string[];
  oldPhones: string[];
};

const targets: Target[] = [
  { name: 'Ann', phone: '0725202635', aliases: ['ann', 'anna'], oldPhones: ['0725202051', '0725202635'] },
  { name: 'Lilian', phone: '0723278950', aliases: ['lilian'], oldPhones: ['0723275970', '0723278950'] },
  { name: 'Caro', phone: '0721918268', aliases: ['caro'], oldPhones: ['0721918208', '0721918268'] },
  { name: 'Mbugua', phone: '0748039767', aliases: ['mbugua'], oldPhones: ['0748039767', '0748079787'] },
  { name: 'Salma', phone: '0718627235', aliases: ['salma'], oldPhones: ['0718637225', '0718627235'] },
  { name: 'Eliza', phone: '0796423612', aliases: ['eliza'], oldPhones: ['0796423612', '0790423612'] },
  { name: 'Dorothy', phone: '0141942523', aliases: ['dorothy'], oldPhones: ['0149492523', '0141942523'] },
  { name: 'Brenda', phone: '0714698489', aliases: ['brenda'], oldPhones: ['0714698489'] },
];

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

const staffRows = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'staff'
    AND tenant_id = ${tenantId}
    AND record->>'branchId' = ${branch.id}
` as { id: string; record: any }[];

const accountRows = await sql`
  SELECT id, record, tenant_id
  FROM app_records
  WHERE collection = 'accounts'
    AND record->>'tenantId' = ${tenantId}
` as { id: string; record: any; tenant_id: string | null }[];

function normalizePhone(value: unknown): string {
  return String(value || '').replace(/\s+/g, '');
}

function normalizeName(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

const usedStaffIds = new Set<string>();
const usedAccountIds = new Set<string>();

let updatedStaff = 0;
let updatedAccounts = 0;
let unresolved = 0;

for (const target of targets) {
  const targetPhone = normalizePhone(target.phone);
  const allPhones = new Set([targetPhone, ...target.oldPhones.map(normalizePhone)]);
  const allNames = new Set([normalizeName(target.name), ...target.aliases.map(normalizeName)]);

  const staffMatch = staffRows.find(row => {
    if (usedStaffIds.has(row.id)) return false;
    const rowPhone = normalizePhone(row.record?.phone);
    const rowName = normalizeName(row.record?.name);
    return allPhones.has(rowPhone) || allNames.has(rowName);
  });

  if (!staffMatch) {
    unresolved++;
    console.log(`No staff match found for ${target.name} (${target.phone})`);
    continue;
  }

  usedStaffIds.add(staffMatch.id);

  const updatedStaffRecord = {
    ...staffMatch.record,
    name: target.name,
    phone: targetPhone,
    tenantId,
    branchId: branch.id,
    branchName: branch.record.name,
    branch: branch.record.name,
  };
  await sql`
    UPDATE app_records
    SET record = ${JSON.stringify(updatedStaffRecord)}::jsonb
    WHERE id = ${staffMatch.id} AND collection = 'staff'
  `;
  updatedStaff++;

  const accountMatch = accountRows.find(row => {
    if (usedAccountIds.has(row.id)) return false;
    const rowPhone = normalizePhone(row.record?.phone);
    const rowName = normalizeName(row.record?.name);
    const rowStaffId = String(row.record?.staffId || '');
    return rowStaffId === staffMatch.id || allPhones.has(rowPhone) || allNames.has(rowName);
  });

  if (!accountMatch) {
    unresolved++;
    console.log(`No account match found for ${target.name} (${target.phone})`);
    continue;
  }

  usedAccountIds.add(accountMatch.id);

  const updatedAccountRecord = {
    ...accountMatch.record,
    tenantId,
    salonName: salon.record.name,
    branchId: branch.id,
    name: target.name,
    phone: targetPhone,
    staffId: staffMatch.id,
    role: accountMatch.record?.role || 'barber',
  };

  await sql`
    UPDATE app_records
    SET tenant_id = ${accountMatch.tenant_id ?? tenantId},
        record = ${JSON.stringify(updatedAccountRecord)}::jsonb
    WHERE id = ${accountMatch.id} AND collection = 'accounts'
  `;
  updatedAccounts++;
}

const finalRows = await sql`
  SELECT record->>'name' AS name, record->>'phone' AS phone
  FROM app_records
  WHERE collection = 'staff'
    AND tenant_id = ${tenantId}
    AND record->>'branchId' = ${branch.id}
    AND record->>'name' = ANY(${targets.map(item => item.name)})
  ORDER BY record->>'name' ASC
` as { name: string; phone: string }[];

console.log(`Updated staff records: ${updatedStaff}`);
console.log(`Updated account records: ${updatedAccounts}`);
console.log(`Unresolved matches: ${unresolved}`);
console.log('Final Main Branch records:');
for (const row of finalRows) console.log(`${row.name}: ${row.phone}`);
