import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const from = Date.parse('2026-10-31T00:00:00+03:00');
const to = Date.parse('2026-11-07T00:00:00+03:00');
const sql = neon(databaseUrl);
const loadTenantRows = async (collection: string) => await sql`
  SELECT id, record FROM app_records
  WHERE collection = ${collection}
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
` as any[];
const [staffRows, appointmentRows, payoutRows, orderRows] = await Promise.all([
  loadTenantRows('staff'), loadTenantRows('appointments'), loadTenantRows('payout_items'),
  sql`
    SELECT id, record FROM app_records
    WHERE collection = 'orders'
      AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
      AND NOT (record ? 'deletedAt')
      AND (record->>'createdAt')::numeric >= ${from}
      AND (record->>'createdAt')::numeric < ${to}
  ` as any[],
]);
const records = (rows: any[]) => rows.map(row => ({ ...row.record, id: String(row.id), tenantId: row.record?.tenantId || row.tenant_id }));
const staff = records(staffRows);
const staffById = new Map(staff.map(member => [String(member.id), member]));
const eligibleStaff = staff.filter(member => !member.deletedAt && member.employmentStatus !== 'laid-off'
  && (!member.branchId || member.branchId === branchId));
const eligibleById = new Map(eligibleStaff.map(member => [String(member.id), member]));
const appointments = records(appointmentRows).filter(item => !item.branchId || item.branchId === branchId);
const appointmentsById = new Map(appointments.map(item => [String(item.id), item]));
const scopedOrders = records(orderRows).filter(order => {
  if (order.branchId) return order.branchId === branchId;
  const appointment = appointmentsById.get(String(order.appointmentId || ''));
  if (appointment?.branchId) return appointment.branchId === branchId;
  return (order.items || []).some((item: any) => [item.staffId, item.coStaffId, item.thirdStaffId, item.helperStaffId]
    .some(id => eligibleById.get(String(id || ''))?.branchId === branchId));
});
const orderIds = scopedOrders.map(order => String(order.id));
const itemKeys = scopedOrders.flatMap(order => (order.items || []).flatMap((item: any, index: number) => item.type === 'service'
  ? [`${order.id}:${index}`, `${order.id}:${index}:co-staff`, `${order.id}:${index}:third-staff`, `${order.id}:${index}:assistant`]
  : []));
const allPayouts = records(payoutRows);
const matchingPayouts = allPayouts.filter(item => orderIds.includes(String(item.orderId || ''))
  || itemKeys.includes(String(item.itemKey || '')));
const payoutItems = matchingPayouts.filter(item => !item.branchId || item.branchId === branchId);
const grossLines = calculateUnpaidStaffEarnings(scopedOrders, [], appointments, from, to)
  .filter(line => line.currency === 'KES' && eligibleById.has(line.staffId));
const unpaidLines = calculateUnpaidStaffEarnings(scopedOrders, payoutItems, appointments, from, to)
  .filter(line => line.currency === 'KES' && eligibleById.has(line.staffId));
const activePaidKeys = new Set(payoutItems.filter(item => !item.deletedAt).map(item => String(item.itemKey || '')));
const unpaidKeys = new Set(unpaidLines.map(line => line.itemKey));
const keys = new Map<string, number>();
for (const line of grossLines) keys.set(line.itemKey, (keys.get(line.itemKey) || 0) + 1);
const duplicateLineKeys = Array.from(keys.entries()).filter(([, count]) => count > 1).map(([itemKey, count]) => ({ itemKey, count }));

const staffTotals = new Map<string, any>();
for (const member of eligibleStaff) staffTotals.set(String(member.id), {
  staffId: String(member.id), name: member.name, commissionKES: 0, assistantKES: 0,
  grossKES: 0, paidKES: 0, unpaidKES: 0, lines: 0, cards: new Set<string>(), missingCardLines: 0, unlinkedWalkInLines: 0,
});
const cardIssues: any[] = [];
for (const line of grossLines) {
  const summary = staffTotals.get(line.staffId);
  if (!summary) continue;
  const order = scopedOrders.find(item => String(item.id) === line.orderId);
  const appointment = appointmentsById.get(String(order?.appointmentId || ''));
  const isPaid = activePaidKeys.has(line.itemKey);
  summary.grossKES += line.amount;
  summary.lines += 1;
  if (line.role === 'assistant') summary.assistantKES += line.amount;
  else summary.commissionKES += line.amount;
  if (isPaid) summary.paidKES += line.amount;
  if (unpaidKeys.has(line.itemKey)) summary.unpaidKES += line.amount;
  if (appointment?.cardNumber) summary.cards.add(String(appointment.cardNumber));
  if (!order?.appointmentId) summary.unlinkedWalkInLines += 1;
  else if (!appointment || appointment.deletedAt || appointment.status !== 'completed' || !appointment.cardNumber) {
    summary.missingCardLines += 1;
    const itemIndex = Number(line.itemKey.slice(line.orderId.length + 1).split(':')[0]);
    const item = order?.items?.[itemIndex] || {};
    cardIssues.push({
      itemKey: line.itemKey,
      orderId: line.orderId,
      orderDate: order?.createdAt ? new Date(Number(order.createdAt)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }) : null,
      orderDeleted: Boolean(order?.deletedAt),
      paymentMethod: order?.paymentMethod || null,
      receipt: order?.mpesaReceiptNumber || null,
      orderRevenueKES: Number(order?.totalByCurrency?.KES || 0),
      service: item.name || null,
      staff: staffById.get(line.staffId)?.name || line.staffId,
      role: line.role,
      amountKES: line.amount,
      appointmentId: order?.appointmentId || null,
      appointmentDate: appointment?.date || null,
      status: appointment?.status || null,
      cardNumber: appointment?.cardNumber || null,
      appointmentDeleted: Boolean(appointment?.deletedAt),
    });
  }
}
const totals = Array.from(staffTotals.values()).map(item => ({
  ...item,
  cards: Array.from(item.cards).sort((left: string, right: string) => Number(left) - Number(right)),
  batchAmountKES: Math.round(item.unpaidKES),
  paystackEligible: Math.round(item.unpaidKES) > 0,
})).sort((left, right) => left.name.localeCompare(right.name));
const grossTotal = grossLines.reduce((sum, line) => sum + line.amount, 0);
const unpaidTotal = unpaidLines.reduce((sum, line) => sum + line.amount, 0);
const paidTotal = grossTotal - unpaidTotal;
const zeroUnpaidWithGross = totals.filter(item => item.grossKES > 0 && item.unpaidKES <= 0);
const outstandingPayoutLineIssues = payoutItems.filter(item => !item.deletedAt && item.itemKey && !grossLines.some(line => line.itemKey === String(item.itemKey)))
  .map(item => ({ payoutId: String(item.id), itemKey: String(item.itemKey), orderId: item.orderId || null }));
const cardIssueRecordIds = Array.from(new Set(cardIssues.flatMap(issue => [issue.orderId, issue.appointmentId]).filter(Boolean)));
const cardIssueAuditRows = cardIssueRecordIds.length ? await sql`
  SELECT
    record->>'recordId' AS record_id,
    record->>'collection' AS record_collection,
    record->>'action' AS action,
    record->>'actor' AS actor,
    record->>'createdAt' AS event_created_at,
    record->>'summary' AS summary
  FROM app_records
  WHERE collection = 'audit_logs'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'recordId' = ANY(${cardIssueRecordIds})
    AND record->>'collection' IN ('order', 'appointment')
` as any[] : [];
console.log(JSON.stringify({
  readOnly: true,
  branch: 'Main Branch',
  period: { from: '2026-10-31', through: '2026-11-06', timezone: 'Africa/Nairobi' },
  totals: {
    grossEarningsKES: grossTotal,
    paidEarningsKES: paidTotal,
    unpaidEarningsKES: unpaidTotal,
    earningsReconcile: Math.round(grossTotal * 100) === Math.round((paidTotal + unpaidTotal) * 100),
    earningLines: grossLines.length,
    duplicateLineKeys: duplicateLineKeys.length,
    activePayoutItems: payoutItems.filter(item => !item.deletedAt).length,
    paystackEligibleStaff: totals.filter(item => item.paystackEligible).length,
    zeroValueBatchCandidates: totals.filter(item => item.paystackEligible && item.batchAmountKES === 0).length,
  },
  staff: totals,
  cardIssues,
  duplicateLineKeys,
  unmatchedActivePayouts: outstandingPayoutLineIssues,
  zeroUnpaidWithGross,
  cardIssueAuditTrail: cardIssueAuditRows.map(row => ({
    recordId: row.record_id,
    collection: row.record_collection,
    action: row.action,
    actor: row.actor,
    createdAt: row.event_created_at ? new Date(Number(row.event_created_at)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }) : null,
    summary: row.summary,
  })),
}, null, 2));