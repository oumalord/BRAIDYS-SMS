import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const csvPath = process.argv.find(value => value.toLowerCase().endsWith('.csv'));
if (!csvPath) throw new Error('Pass the authoritative payroll CSV path.');

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(value);
      value = '';
    } else value += character;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  fields.push(value);
  return fields;
}

const csvLines = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
const parsedCsv = csvLines.map(parseCsvRow);
const headerIndex = parsedCsv.findIndex(row => row.includes('Staff ID') && row.includes('Total earnings (KES)'));
if (headerIndex < 0) throw new Error('CSV must include Staff ID and Total earnings (KES) columns.');
const headers = parsedCsv[headerIndex];
const idIndex = headers.indexOf('Staff ID');
const amountIndex = headers.indexOf('Total earnings (KES)');
const csvTotals = new Map<string, number>();
for (const row of parsedCsv.slice(headerIndex + 1)) {
  const staffId = String(row[idIndex] || '').trim();
  if (!staffId || staffId === 'TOTAL') continue;
  const amount = Number(String(row[amountIndex] || '').replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount < 0 || csvTotals.has(staffId)) throw new Error(`Invalid or duplicate CSV row for ${staffId}.`);
  csvTotals.set(staffId, Math.round(amount));
}
if (csvTotals.size !== 40 || Array.from(csvTotals.values()).reduce((sum, amount) => sum + amount, 0) !== 299085) {
  throw new Error(`Unexpected CSV scope: ${csvTotals.size} staff / KES ${Array.from(csvTotals.values()).reduce((sum, amount) => sum + amount, 0)}.`);
}

const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const from = Date.parse('2026-10-31T00:00:00+03:00');
const to = Date.parse('2026-11-07T00:00:00+03:00');
const sql = neon(databaseUrl);
const load = async (collection: string) => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = ${collection}
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
` as any[];
const [staffRows, orderRows, appointmentRows, payoutRows, auditRows, payrollItemRows] = await Promise.all([
  load('staff'), load('orders'), load('appointments'), load('payout_items'), load('audit_logs'), load('payroll_items'),
]);
const records = (rows: any[]) => rows.map(row => ({
  ...row.record, id: String(row.id), tenantId: row.record?.tenantId || row.tenant_id,
}));
const staff = records(staffRows).filter(member => !member.deletedAt && member.employmentStatus !== 'laid-off'
  && (!member.branchId || member.branchId === branchId));
const staffById = new Map(staff.map(member => [String(member.id), member]));
const appointments = records(appointmentRows);
const appointmentsById = new Map(appointments.map(item => [String(item.id), item]));
const orders = records(orderRows);
const payoutItems = records(payoutRows);
const audits = records(auditRows);
const payrollItems = records(payrollItemRows);
const restoreAudit = audits.find(item => item.action === 'restored assistant soft-deleted records');
if (!restoreAudit || !Array.isArray(restoreAudit.recordIds)) throw new Error('Restore audit and record IDs are required.');
const restoredOrderIds = new Set(restoreAudit.recordIds.map(String));
const duplicateAudits = audits.filter(item => restoredOrderIds.has(String(item.recordId || ''))
  && ['voided duplicate order', 'voided order linked to deleted appointment'].includes(String(item.action))
  && item.recordSnapshot && item.recordId);
const auditByOrderId = new Map<string, any>();
for (const audit of duplicateAudits.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))) {
  auditByOrderId.set(String(audit.recordId), audit);
}
const candidateOrders = Array.from(auditByOrderId.entries()).flatMap(([id, audit]) => {
  const order = orders.find(item => String(item.id) === id);
  if (!order) {
    throw new Error(`Restored duplicate ${id} is missing.`);
  }
  if (Number(order.createdAt || 0) < from || Number(order.createdAt || 0) >= to) return [];
  if (order.deletedAt) {
    throw new Error(`Restored duplicate ${id} is not active in the payroll period.`);
  }
  if (order.customerId) throw new Error(`Duplicate ${id} has a customer account and requires balance reconciliation.`);
  const hasInventory = (order.items || []).some((item: any) => item.type === 'product' && item.refId
    || (item.consumedProducts || []).some((used: any) => used.productId && Number(used.qty || 0) !== 0));
  if (hasInventory) throw new Error(`Duplicate ${id} has inventory effects and cannot be re-voided by this payroll reconciler.`);
  const activePayout = payoutItems.some(item => !item.deletedAt && (String(item.orderId || '') === id
    || String(item.itemKey || '').startsWith(`${id}:`)));
  if (activePayout) throw new Error(`Duplicate ${id} has active paid markers and cannot be removed from earnings.`);
  const pendingPayroll = payrollItems.some(item => ['submitting', 'pending', 'unknown', 'review', 'success'].includes(String(item.status))
    && (Array.isArray(item.itemKeys) ? item.itemKeys : []).some((key: unknown) => String(key).startsWith(`${id}:`)));
  if (pendingPayroll) throw new Error(`Duplicate ${id} is attached to a non-failed payroll transfer; refusing to alter it.`);
  return [{ id, order, audit, snapshot: audit.recordSnapshot }];
});
if (!candidateOrders.length || candidateOrders.length > 20) throw new Error(`Unexpected duplicate candidate count: ${candidateOrders.length}.`);

const eligibleIds = new Set(staff.map(member => String(member.id)));
const scopedOrders = orders.filter(order => {
  if (order.branchId) return order.branchId === branchId;
  const appointment = appointmentsById.get(String(order.appointmentId || ''));
  if (appointment?.branchId) return appointment.branchId === branchId;
  return (order.items || []).some((item: any) => [item.staffId, item.coStaffId, item.thirdStaffId, item.helperStaffId]
    .some(id => staffById.get(String(id || ''))?.branchId === branchId));
});
const activePayouts = payoutItems.filter(item => !item.deletedAt);
const currentLines = calculateUnpaidStaffEarnings(scopedOrders, activePayouts, appointments, from, to)
  .filter(line => line.currency === 'KES' && eligibleIds.has(line.staffId));
const currentTotals = new Map<string, number>();
for (const line of currentLines) currentTotals.set(line.staffId, (currentTotals.get(line.staffId) || 0) + line.amount);
const contributions = candidateOrders.map(({ order }) => {
  const lines = calculateUnpaidStaffEarnings([order], activePayouts, appointments, from, to)
    .filter(line => line.currency === 'KES' && eligibleIds.has(line.staffId));
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.staffId, (totals.get(line.staffId) || 0) + line.amount);
  return totals;
});
const effectiveCandidateIndexes = contributions.flatMap((totals, index) => totals.size ? [index] : []);
const effectiveCandidates = effectiveCandidateIndexes.map(index => candidateOrders[index]);
const effectiveContributions = effectiveCandidateIndexes.map(index => contributions[index]);
const expectedStaffIds = new Set(csvTotals.keys());
const currentDiffs = Array.from(expectedStaffIds).filter(id => !staffById.has(id));
if (currentDiffs.length) throw new Error(`CSV staff are outside the active Main Branch payroll scope: ${currentDiffs.join(', ')}`);
const solutions: number[] = [];
const subsetCount = 1 << effectiveCandidates.length;
for (let mask = 0; mask < subsetCount; mask += 1) {
  let matches = true;
  for (const staffId of expectedStaffIds) {
    let amount = currentTotals.get(staffId) || 0;
    for (let index = 0; index < effectiveCandidates.length; index += 1) {
      if (mask & (1 << index)) amount -= effectiveContributions[index].get(staffId) || 0;
    }
    if (Math.round(amount) !== csvTotals.get(staffId)) { matches = false; break; }
  }
  if (matches) solutions.push(mask);
  if (solutions.length > 1) break;
}
if (solutions.length > 1) {
  console.log(JSON.stringify({
    ambiguous: true,
      matchingSubsets: solutions.map(mask => effectiveCandidates.flatMap((candidate, index) => mask & (1 << index) ? [{
      id: candidate.id,
      customerName: candidate.order.customerName || 'Walk-in Customer',
      appointmentId: candidate.order.appointmentId || null,
        contributionsKESByStaffId: Object.fromEntries(effectiveContributions[index]),
    }] : [])),
    action: 'No records changed. Resolve which duplicate subset is authoritative before applying the CSV correction.',
  }, null, 2));
  process.exit(0);
}
if (!solutions.length) throw new Error('No subset of the audited duplicate orders exactly matches the authoritative CSV.');
const selectedMask = solutions[0];
const targets = effectiveCandidates.filter((_, index) => Boolean(selectedMask & (1 << index)));
const currentTotalKES = Array.from(currentTotals.values()).reduce((sum, amount) => sum + amount, 0);
const expectedTotalKES = Array.from(csvTotals.values()).reduce((sum, amount) => sum + amount, 0);
const currentPaystackBatchKES = Array.from(csvTotals.keys()).reduce((sum, id) => sum + Math.round(currentTotals.get(id) || 0), 0);
const targetContributionKES = targets.reduce((sum, target, targetIndex) => {
  const candidateIndex = candidateOrders.findIndex(candidate => candidate.id === target.id);
  return sum + Array.from(contributions[candidateIndex].values()).reduce((staffSum, amount) => staffSum + amount, 0);
}, 0);
const preview = {
  source: csvPath,
  csvStaffCount: csvTotals.size,
  csvPayrollKES: expectedTotalKES,
  currentPayrollKES: currentTotalKES,
  currentPaystackBatchKES,
  staffRowsMatchingBefore: Array.from(csvTotals.keys()).filter(id => Math.round(currentTotals.get(id) || 0) === csvTotals.get(id)).length,
  duplicateCandidates: effectiveCandidates.length,
  exactMatchingDuplicateOrders: targets.map(({ id, order }) => ({ id, customerName: order.customerName || 'Walk-in Customer', appointmentId: order.appointmentId || null })),
  earningContributionRemovedKES: targetContributionKES,
};

if (!process.argv.includes('--confirm')) {
  console.log(JSON.stringify({ dryRun: true, ...preview, action: 'No records changed. Pass --confirm to soft-delete only the exact duplicate orders required to match the supplied CSV.' }, null, 2));
} else if (targets.length) {
  const restoredAt = Number(restoreAudit.createdAt);
  const restoreAuditId = String(restoreAudit.id);
  const stillRestored = await sql`
    SELECT COUNT(*)::integer AS count FROM app_records
    WHERE collection = 'audit_logs' AND id = ${restoreAuditId}
      AND record->>'action' = 'restored assistant soft-deleted records'
  ` as any[];
  if (Number(stillRestored[0]?.count || 0) !== 1) throw new Error('Restore audit changed during CSV reconciliation.');
  const reason = `Owner designated the supplied ${csvPath.split(/[\\/]/).pop()} payroll CSV as the source of truth for Oct 31-Nov 6; duplicate orders excluded.`;
  const voidedAt = Date.now();
  const reconciliationId = randomUUID();
  const recordIds = targets.map(target => target.id);
  const auditRecord = {
    id: reconciliationId, tenantId, branchId, actor: 'owner', action: 'reconciled payroll to supplied CSV',
    collection: 'audit_restore', recordId: null, summary: 'Excluded only audited duplicate orders to match the supplied payroll CSV.',
    restoredAt, source: csvPath.split(/[\\/]/).pop(), expectedTotalKES, previousTotalKES: currentTotalKES,
    matchedTotalKES: currentPaystackBatchKES, targetOrderIds: recordIds,
    excludedEarningsKES: targetContributionKES, createdAt: voidedAt,
    snapshots: targets.map(({ id, snapshot }) => ({ id, snapshot })),
  };
  const results = await sql.transaction(txn => [
    txn`UPDATE app_records SET record = record || jsonb_build_object(
        'deletedAt', ${voidedAt}::bigint, 'deletedBy', 'owner', 'voidReason', ${reason}::text
      )
      WHERE collection = 'orders' AND id = ANY(${recordIds}) AND NOT (record ? 'deletedAt')
      RETURNING id`,
    txn`INSERT INTO app_records (id, collection, tenant_id, record)
      VALUES (${reconciliationId}, 'audit_logs', ${tenantId}, ${JSON.stringify(auditRecord)}::jsonb)
      RETURNING id`,
  ]);
  if (results[0].length !== targets.length || results[1].length !== 1) throw new Error('CSV reconciliation row-count check failed; transaction rolled back.');
  console.log(JSON.stringify({ reconciled: true, ...preview, reconciliationId, voidedOrderIds: recordIds }, null, 2));
}
