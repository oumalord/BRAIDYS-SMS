import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomBytes, scryptSync } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);

function passwordHash(value: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}

function normalizePhone(value: unknown): string {
  return String(value || '').replace(/\s+/g, '');
}

function normalizeName(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

type TargetStaff = {
  name: string;
  phone: string;
  aliases: string[];
  oldPhones: string[];
};

const targets: TargetStaff[] = [
  { name: 'Lydia', phone: '0797868442', aliases: ['yulie', 'lydia'], oldPhones: ['0797868442'] },
  { name: 'Hellen', phone: '0711361199', aliases: ['helen', 'hellen'], oldPhones: ['0711321199', '0711361199'] },
  { name: 'Megan', phone: '0757219272', aliases: ['megan'], oldPhones: ['0757219272'] },
  { name: 'Josphine', phone: '0703739242', aliases: ['josephine', 'josphine'], oldPhones: ['0703739242'] },
  { name: 'Muthoni', phone: '0759548641', aliases: ['mumoni', 'muthoni'], oldPhones: ['0759548641'] },
  { name: 'Naomi', phone: '0116371248', aliases: ['naomi'], oldPhones: ['0116372148', '0116371248'] },
  { name: 'Agnes', phone: '0799328414', aliases: ['agnes'], oldPhones: ['0799328414'] },
  { name: 'Pauline', phone: '0790106928', aliases: ['pauline'], oldPhones: ['07901069228', '0790106928'] },
  { name: 'Adolphine', phone: '0706713659', aliases: ['adolphine'], oldPhones: ['0706713659'] },
  { name: 'Angela', phone: '0728156065', aliases: ['angela'], oldPhones: ['0728156065'] },
  { name: 'Keziah', phone: '0769165908', aliases: ['keziah'], oldPhones: ['0769165908'] },
  { name: 'Mercy', phone: '0703774050', aliases: ['mercy'], oldPhones: ['0703774050'] },
  { name: 'Nyambura', phone: '0710367189', aliases: ['nyambura'], oldPhones: ['0710367189'] },
  { name: 'Emily', phone: '0726842243', aliases: ['emily'], oldPhones: ['0726842243'] },
  { name: 'Akisa', phone: '0790585672', aliases: ['akisa'], oldPhones: ['0790585672'] },
  { name: 'Njeru', phone: '0704914112', aliases: ['njeri', 'njeru'], oldPhones: ['0704914112'] },
  { name: 'Tifa', phone: '0759243562', aliases: ['tiya', 'tifa'], oldPhones: ['0759243562'] },
  { name: 'Grace', phone: '0768970415', aliases: ['grace'], oldPhones: ['0768970415'] },
  { name: 'Palenda', phone: '0703540925', aliases: ['palencia', 'palenda'], oldPhones: ['0703540925'] },
  { name: 'Wanjiru', phone: '0794990402', aliases: ['klongivu', 'wanjiru'], oldPhones: ['0794990402'] },
  { name: 'Kabi', phone: '0746531221', aliases: ['kabi'], oldPhones: ['074653121', '0746531221'] },
  { name: 'Triza', phone: '0111952328', aliases: ['triza'], oldPhones: ['0111952328'] },
  { name: 'Diana', phone: '0794705370', aliases: ['diana'], oldPhones: ['0794705370'] },
  { name: 'Faith', phone: '0740667333', aliases: ['faith'], oldPhones: ['0740667333'] },
  { name: 'Millicent', phone: '0717298144', aliases: ['millicent'], oldPhones: ['0747298144', '0717298144'] },
  { name: 'Alice', phone: '0704671501', aliases: ['alice'], oldPhones: ['0704671501'] },
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

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;

const staffRows = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'staff' AND tenant_id = ${tenantId}
` as { id: string; record: any }[];

const accountRows = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'accounts' AND record->>'tenantId' = ${tenantId}
` as { id: string; record: any }[];

const usedStaffIds = new Set<string>();
const usedAccountIds = new Set<string>();

let correctedStaff = 0;
let correctedAccounts = 0;
const unresolved: string[] = [];

for (const target of targets) {
  const phone = normalizePhone(target.phone);
  const candidatePhones = new Set([phone, ...target.oldPhones.map(normalizePhone)]);
  const candidateNames = new Set([normalizeName(target.name), ...target.aliases.map(normalizeName)]);

  const staff = staffRows.find(row => {
    if (usedStaffIds.has(row.id)) return false;
    if (String(row.record?.branchId || '') !== String(branch.id)) return false;
    const rowPhone = normalizePhone(row.record?.phone);
    const rowName = normalizeName(row.record?.name);
    return candidatePhones.has(rowPhone) || candidateNames.has(rowName);
  });

  if (!staff) {
    unresolved.push(`${target.name} (${target.phone})`);
    continue;
  }

  usedStaffIds.add(staff.id);

  const updatedStaff = {
    ...staff.record,
    name: target.name,
    phone,
    tenantId,
    branchId: branch.id,
    branchName: branch.record.name,
    branch: branch.record.name,
  };

  await sql`
    UPDATE app_records
    SET record = ${JSON.stringify(updatedStaff)}::jsonb, tenant_id = ${tenantId}
    WHERE id = ${staff.id} AND collection = 'staff'
  `;
  correctedStaff++;

  const account = accountRows.find(row => {
    if (usedAccountIds.has(row.id)) return false;
    const rowRole = normalizeName(row.record?.role);
    if (rowRole === 'owner' || rowRole === 'admin') return false;
    const rowPhone = normalizePhone(row.record?.phone);
    const rowName = normalizeName(row.record?.name);
    const rowStaffId = String(row.record?.staffId || '');
    return rowStaffId === staff.id || candidatePhones.has(rowPhone) || candidateNames.has(rowName);
  });

  if (account) {
    usedAccountIds.add(account.id);
    const updatedAccount = {
      ...account.record,
      tenantId,
      salonName: salon.record.name,
      branchId: branch.id,
      name: target.name,
      phone,
      staffId: staff.id,
    };
    await sql`
      UPDATE app_records
      SET record = ${JSON.stringify(updatedAccount)}::jsonb, tenant_id = ${tenantId}
      WHERE id = ${account.id} AND collection = 'accounts'
    `;
    correctedAccounts++;
  }
}

const allStaffAccounts = await sql`
  SELECT id, record
  FROM app_records
  WHERE collection = 'accounts'
    AND record->>'staffId' <> ''
` as { id: string; record: any }[];

let resetPins = 0;
for (const account of allStaffAccounts) {
  const role = String(account.record?.role || '').toLowerCase();
  if (!['barber', 'receptionist'].includes(role)) continue;
  const updated = {
    ...account.record,
    pinHash: passwordHash('1234'),
    pinChangedAt: null,
  };
  await sql`UPDATE app_records SET record = ${JSON.stringify(updated)}::jsonb WHERE id = ${account.id} AND collection = 'accounts'`;
  resetPins++;
}

const keepCollections = ['salons', 'branches', 'accounts', 'staff'];
await sql`DELETE FROM app_records WHERE collection <> ALL(${keepCollections})`;

await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;

const finalMainStaff = await sql`
  SELECT record->>'name' AS name, record->>'phone' AS phone
  FROM app_records
  WHERE collection = 'staff'
    AND tenant_id = ${tenantId}
    AND record->>'branchId' = ${branch.id}
    AND record->>'name' = ANY(${targets.map(item => item.name)})
  ORDER BY record->>'name' ASC
` as { name: string; phone: string }[];

console.log(`Corrected MAIN Branch staff records: ${correctedStaff}`);
console.log(`Corrected linked account records: ${correctedAccounts}`);
console.log(`Staff PINs reset to 1234 with forced change: ${resetPins}`);
console.log(`Operational data cleared; retained collections: ${keepCollections.join(', ')}`);
if (unresolved.length) {
  console.log('Unresolved entries:');
  for (const item of unresolved) console.log(`- ${item}`);
}
console.log('Final confirmed MAIN Branch staff details:');
for (const row of finalMainStaff) console.log(`${row.name}: ${row.phone}`);
