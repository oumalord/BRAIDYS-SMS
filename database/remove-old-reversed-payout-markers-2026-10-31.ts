import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const rows = async (collection: string) => await sql`
  SELECT id, tenant_id, record
  FROM app_records
  WHERE collection = ${collection}
` as { id: string; tenant_id: string | null; record: Record<string, any> }[];
const accountRows = await rows('accounts');
const ownerAccounts = accountRows.map(row => ({ ...row.record, id: row.id, tenantId: row.record.tenantId || row.tenant_id }))
  .filter(account => String(account.name || '').trim().toLowerCase() === 'esther muthoni'
    && String(account.role || '').toLowerCase() === 'owner'
    && String(account.salonName || '').toLowerCase().includes('braid'));
if (ownerAccounts.length !== 1) throw new Error(`Expected one matching salon owner, found ${ownerAccounts.length}`);

const tenantId = String(ownerAccounts[0].tenantId || '');
const [branchRows, staffRows, appointmentRows, orderRows, payoutRows, batchRows] = await Promise.all([
  rows('branches'), rows('staff'), rows('appointments'), rows('orders'), rows('payout_items'), rows('payout_batches'),
]);
const branches = branchRows.map(row => ({ ...row.record, id: row.id }));
const mainBranches = branches.filter(branch => String(branch.name || '').trim().toLowerCase() === 'main branch'
  && String(branch.salonId || branch.tenantId || '') === tenantId);
if (mainBranches.length !== 1) throw new Error(`Expected one Main Branch for the salon, found ${mainBranches.length}`);
const branchId = String(mainBranches[0].id);
const staff = staffRows.filter(row => (row.tenant_id === tenantId || row.record.tenantId === tenantId) && !row.record.deletedAt)
  .map(row => ({ ...row.record, id: row.id }));
const staffById = new Map(staff.map(member => [String(member.id), member]));
const appointments = appointmentRows.filter(row => row.tenant_id === tenantId || row.record.tenantId === tenantId)
  .map(row => ({ ...row.record, id: row.id }));
const appointmentsById = new Map(appointments.map(appointment => [String(appointment.id), appointment]));
const orders = orderRows.filter(row => (row.tenant_id === tenantId || row.record.tenantId === tenantId) && !row.record.deletedAt)
  .map(row => ({ ...row.record, id: row.id }));
const ordersById = new Map(orders.map(order => [String(order.id), order]));
const cutoff = Date.parse('2026-10-24T00:00:00+03:00');
const reason = 'Owner requested reversal: internal paid marker was recorded without a confirmed transfer. Earnings restored to unpaid.';
const reversalRows = payoutRows.filter(row => {
  if (row.tenant_id !== tenantId && row.record.tenantId !== tenantId) return false;
  if (!row.record.deletedAt || row.record.deletionReason !== reason || Number(row.record.deletedAt) >= cutoff) return false;
  if (row.record.branchId && row.record.branchId !== branchId) return false;
  if (row.record.branchId === branchId) return true;
  const order = ordersById.get(String(row.record.orderId || ''));
  const appointment = appointmentsById.get(String(order?.appointmentId || ''));
  const orderBranch = order?.branchId || appointment?.branchId;
  if (orderBranch) return orderBranch === branchId;
  const itemIndex = Number(String(row.record.itemKey || '').split(':')[1]);
  const orderItem = Number.isInteger(itemIndex) ? order?.items?.[itemIndex] : null;
  const staffIds = [row.record.staffId, orderItem?.staffId, orderItem?.coStaffId, orderItem?.thirdStaffId, orderItem?.helperStaffId];
  return staffIds.some(id => staffById.get(String(id || ''))?.branchId === branchId);
});
const batchIds = new Set(reversalRows.map(row => String(row.record.batchId || '')).filter(Boolean));
const reversedBatches = batchRows.filter(row => (row.tenant_id === tenantId || row.record.tenantId === tenantId)
  && row.record.status === 'reversed'
  && !row.record.deletedAt
  && Number(row.record.createdAt || 0) < cutoff
  && (row.record.branchId === branchId || (!row.record.branchId && batchIds.has(row.id))));
const totalKES = reversalRows.reduce((total, row) => total + Number(row.record.commission || 0), 0);
const expectedCount = 108;
const expectedTotalCents = 4_432_990;
if (reversalRows.length !== expectedCount || Math.round(totalKES * 100) !== expectedTotalCents || reversedBatches.length !== 2) {
  throw new Error(`Refusing deletion: found ${reversalRows.length} items / KES ${totalKES} / ${reversedBatches.length} batches; expected ${expectedCount} / KES 44329.90 / 2.`);
}

const confirmed = process.argv.includes('--confirm');
if (!confirmed) {
  console.log(JSON.stringify({ dryRun: true, branch: 'Main Branch', alreadySoftDeletedReversalItems: reversalRows.length, totalKES, activeReversedBatches: reversedBatches.length, action: 'No records changed. Pass --confirm to archive these exact September 26 reversal batches.' }, null, 2));
} else {
  const batchRecordIds = reversedBatches.map(row => row.id);
  const deletedAt = Date.now();
  const archivedRows = await sql`
    UPDATE app_records
    SET record = record || jsonb_build_object(
      'deletedAt', ${deletedAt}::bigint,
      'deletedBy', 'owner',
      'deletionReason', 'Archived obsolete reversed legacy payout batch at owner request'
    )
    WHERE collection = 'payout_batches'
      AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
      AND id = ANY(${batchRecordIds})
      AND record->>'status' = 'reversed'
      AND NOT (record ? 'deletedAt')
    RETURNING id
  ` as { id: string }[];
  const archivedBatches = archivedRows.length;
  if (archivedBatches !== 2) {
    throw new Error(`Archive count mismatch: archived ${archivedBatches} batches.`);
  }
  console.log(JSON.stringify({ archived: true, branch: 'Main Branch', alreadySoftDeletedReversalItems: reversalRows.length, totalKES, archivedBatches }, null, 2));
}