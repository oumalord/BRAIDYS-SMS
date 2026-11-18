import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const rows = await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = 'accounts'
  ORDER BY created_at DESC
  LIMIT 5000
` as any[];
const triggers = await sql`
  SELECT tgname, pg_get_triggerdef(oid) AS definition
  FROM pg_trigger
  WHERE tgrelid = 'app_records'::regclass AND NOT tgisinternal
  ORDER BY tgname
` as any[];
const probeAccount = rows.map(row => row.record || {}).find(account => account.status === 'active'
  && (account.passwordHash || account.pinHash) && (account.email || account.phone));
let liveLoginProbe: { status: number; response: string } | null = null;
if (probeAccount) {
  const response = await fetch('https://braidysms.vercel.app/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: probeAccount.email || probeAccount.phone, credential: 'read-only-invalid-credential-20261107' }),
  });
  liveLoginProbe = { status: response.status, response: await response.text() };
}
const issues = rows.flatMap(row => {
  const account = row.record || {};
  const checks = ['passwordHash', 'pinHash'].flatMap(field => {
    const value = account[field];
    if (!value) return [];
    const [salt, digest, extra] = String(value).split(':');
    const valid = !extra && /^[0-9a-f]{32}$/i.test(salt || '') && /^[0-9a-f]{128}$/i.test(digest || '');
    return valid ? [] : [{ field, malformed: true }];
  });
  return checks.length ? [{
    id: String(row.id),
    tenantId: account.tenantId || row.tenant_id || null,
    role: String(account.role || ''),
    status: String(account.status || ''),
    hasEmail: Boolean(account.email),
    hasPhone: Boolean(account.phone),
    credentialIssues: checks,
  }] : [];
});
console.log(JSON.stringify({
  readOnly: true,
  accountsChecked: rows.length,
  malformedCredentialAccounts: issues,
  appRecordTriggers: triggers.map(trigger => ({ name: trigger.tgname, definition: trigger.definition })),
  liveLoginProbe,
}, null, 2));
