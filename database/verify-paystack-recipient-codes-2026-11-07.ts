import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const secretKey = String(process.env.PAYSTACK_SECRET_KEY || '');
if (!secretKey.startsWith('sk_live_')) throw new Error('A live Paystack key is required for read-only recipient verification.');

const tenantId = 'salon-852a7423ca75d9db';
const sql = neon(databaseUrl);
const batchRows = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'payroll_batches'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'provider' = 'paystack'
  ORDER BY (record->>'createdAt')::numeric DESC
  LIMIT 1
` as any[];
if (!batchRows.length) throw new Error('No Paystack payroll batch was found.');
const batchId = String(batchRows[0].id);
const [itemRows, staffRows] = await Promise.all([
  sql`SELECT id, record FROM app_records
    WHERE collection = 'payroll_items'
      AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
      AND record->>'provider' = 'paystack' AND record->>'batchId' = ${batchId}` as any[],
  sql`SELECT id, record FROM app_records
    WHERE collection = 'staff' AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})` as any[],
]);
const transferItems = itemRows.map(row => row.record);
const staffById = new Map(staffRows.map(row => [String(row.id), row.record]));
const response = await fetch('https://api.paystack.co/transferrecipient?perPage=100&page=1', {
  headers: { Authorization: `Bearer ${secretKey}` },
});
const body: any = await response.json().catch(() => ({}));
if (!response.ok || !body.status || !Array.isArray(body.data)) {
  throw new Error(`Paystack recipient lookup failed (${response.status}): ${String(body.message || 'Invalid response')}`);
}
const providerByCode = new Map<string, any>(body.data.map((item: any) => [String(item.recipient_code || ''), item]));
console.log(JSON.stringify({
  readOnly: true,
  batchId,
  transferCount: transferItems.length,
  recipientPageCount: body.data.length,
  recipientTotal: body.meta?.total || null,
  matches: transferItems.map(item => {
    const recipient = providerByCode.get(String(item.recipientCode || ''));
    const normalizePhone = (value: unknown) => {
      const digits = String(value || '').replace(/\D/g, '');
      return digits.startsWith('0') ? `254${digits.slice(1)}` : digits;
    };
    const staffPhone = normalizePhone(staffById.get(String(item.staffId))?.phone);
    const recipientPhone = normalizePhone(recipient?.details?.account_number);
    return {
      staffName: item.staffName,
      found: Boolean(recipient),
      type: recipient?.type || null,
      currency: recipient?.currency || null,
      bankCode: recipient?.details?.bank_code || null,
      active: recipient?.active ?? null,
      liveDomain: recipient?.domain === 'live',
      staffPhoneValid: /^254[17]\d{8}$/.test(staffPhone),
      recipientPhoneValid: /^254[17]\d{8}$/.test(recipientPhone),
      phoneMatchesStaff: Boolean(staffPhone && staffPhone === recipientPhone),
    };
  }),
}, null, 2));
