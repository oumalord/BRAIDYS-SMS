import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings, currentSaturdayThroughFridayRange } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const secretKey = String(process.env.PAYSTACK_SECRET_KEY || '');
const multiplier = Number(process.env.PAYSTACK_TRANSFER_AMOUNT_MULTIPLIER || 100);
const sql = neon(databaseUrl);
const [branches, staffRows, orderRows, payoutRows, appointmentRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'branches' AND record->>'status' = 'active'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'staff'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'payout_items'`,
  sql`SELECT id, record FROM app_records WHERE collection = 'appointments'`,
]) as [any[], any[], any[], any[], any[]];

const branchesById = new Map(branches.map(row => [String(row.id), row.record]));
const staff = staffRows.map(row => ({ ...row.record, id: String(row.id) }));
const staffById = new Map(staff.map(member => [String(member.id), member]));
const orders = orderRows.map(row => ({ ...row.record, id: String(row.id) }));
const payoutItems = payoutRows.map(row => ({ ...row.record, id: String(row.id) }));
const appointments = appointmentRows.map(row => ({ ...row.record, id: String(row.id) }));
const period = currentSaturdayThroughFridayRange();
const earningLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, period.from, period.to)
  .filter(line => line.currency === 'KES' && staffById.has(line.staffId));
const nowEligibleStaff = staff.filter(member => !member.deletedAt && member.employmentStatus !== 'laid-off'
  && !String(member.role || '').toLowerCase().includes('admin'));
const totalsByStaff = new Map<string, number>();
for (const line of earningLines) totalsByStaff.set(line.staffId, (totalsByStaff.get(line.staffId) || 0) + line.amount);
const dueStaff = nowEligibleStaff.map(member => ({
  member,
  amountKES: Math.round(totalsByStaff.get(String(member.id)) || 0),
})).filter(row => row.amountKES > 0);
const localRecipientValid = (member: any) => member.paystackRecipientMode === 'live'
  && /^RCP_[A-Za-z0-9]+$/.test(String(member.paystackRecipientCode || ''));
const dueCount = dueStaff.length;
const dueTotalKES = dueStaff.reduce((sum, row) => sum + row.amountKES, 0);
const dueMinor = Number.isSafeInteger(multiplier) && multiplier > 0 ? dueTotalKES * multiplier : 0;
const missingLocalRecipientCount = dueStaff.filter(row => !localRecipientValid(row.member)).length;
const byBranch = new Map<string, { branch: string; staffCount: number; totalKES: number; missingLocalRecipientCount: number }>();
for (const row of dueStaff) {
  const branchId = String(row.member.branchId || 'unassigned');
  const branchName = String(branchesById.get(branchId)?.name || row.member.branchName || row.member.branch || 'Unassigned');
  const total = byBranch.get(branchId) || { branch: branchName, staffCount: 0, totalKES: 0, missingLocalRecipientCount: 0 };
  total.staffCount += 1;
  total.totalKES += row.amountKES;
  if (!localRecipientValid(row.member)) total.missingLocalRecipientCount += 1;
  byBranch.set(branchId, total);
}

const result: Record<string, any> = {
  readOnly: true,
  period: { from: new Date(period.from).toISOString(), toExclusive: new Date(period.to).toISOString() },
  keyMode: secretKey.startsWith('sk_live_') ? 'live' : secretKey.startsWith('sk_test_') ? 'test' : secretKey ? 'unrecognized' : 'missing',
  multiplier,
  amountCalculationSafe: Number.isSafeInteger(multiplier) && multiplier > 0 && Number.isSafeInteger(dueMinor),
  payroll: { dueStaffCount: dueCount, totalKES: dueTotalKES, amountInMinorUnits: dueMinor, missingLocalRecipientCount },
  byBranch: Array.from(byBranch.values()),
};

if (secretKey.startsWith('sk_live_')) {
  const headers = { Authorization: `Bearer ${secretKey}` };
  try {
    const [balanceResponse, recipientResponse] = await Promise.all([
      fetch('https://api.paystack.co/balance', { headers, signal: AbortSignal.timeout(15000) }),
      fetch('https://api.paystack.co/transferrecipient?perPage=100', { headers, signal: AbortSignal.timeout(15000) }),
    ]);
    const [balanceBody, recipientBody]: any[] = await Promise.all([
      balanceResponse.json().catch(() => ({})), recipientResponse.json().catch(() => ({})),
    ]);
    const balances = Array.isArray(balanceBody?.data) ? balanceBody.data : [];
    const kesBalance = balances.find((item: any) => String(item.currency || '').toUpperCase() === 'KES');
    const remoteCodes = new Set((Array.isArray(recipientBody?.data) ? recipientBody.data : [])
      .map((item: any) => String(item.recipient_code || '')).filter(Boolean));
    const dueRecipientsMissingRemotely = dueStaff.filter(row => localRecipientValid(row.member)
      && !remoteCodes.has(String(row.member.paystackRecipientCode))).length;
    result.paystackReadiness = {
      balanceHttpStatus: balanceResponse.status,
      balanceAuthorized: balanceResponse.ok && Boolean(balanceBody?.status),
      kesBalanceAvailable: Number.isFinite(Number(kesBalance?.balance)),
      kesBalance: Number.isFinite(Number(kesBalance?.balance)) ? Number(kesBalance.balance) : null,
      sufficientBalanceForPrincipal: Number.isFinite(Number(kesBalance?.balance)) && Number(kesBalance.balance) >= dueMinor,
      recipientDirectoryHttpStatus: recipientResponse.status,
      recipientDirectoryAuthorized: recipientResponse.ok && Boolean(recipientBody?.status),
      remoteRecipientCount: Array.isArray(recipientBody?.data) ? recipientBody.data.length : null,
      dueRecipientsMissingRemotely,
      listMayBePaginated: Boolean(recipientBody?.meta?.page && recipientBody?.meta?.page < recipientBody?.meta?.pageCount),
    };
  } catch (cause) {
    result.paystackReadiness = { requestSucceeded: false, error: cause instanceof Error ? cause.message : 'Paystack read-only preflight failed.' };
  }
} else {
  result.paystackReadiness = { requestSucceeded: false, reason: 'A live secret key is required for a live-account preflight; no API request was made.' };
}

console.log(JSON.stringify(result, null, 2));
