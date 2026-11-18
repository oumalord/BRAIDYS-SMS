import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { staffCommission } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const fromDate = '2026-10-24';
const throughDate = '2026-10-30';
const collections = ['staff', 'branches', 'appointments', 'orders', 'payout_items', 'payout_batches', 'payroll_items', 'payroll_batches'];
const rowsByCollection = Object.fromEntries(await Promise.all(collections.map(async collection => [
  collection,
  await sql`SELECT id, tenant_id, created_at, record FROM app_records WHERE collection = ${collection}` as any[],
]))) as Record<string, any[]>;
const records = (collection: string) => rowsByCollection[collection].map(row => ({
  ...row.record,
  id: String(row.id),
  tenantId: row.record?.tenantId || row.tenant_id,
  dbInsertedAt: row.created_at,
}));
const staffRows = records('staff').filter(staff => String(staff.name || '').trim().toLowerCase() === 'eliza'
  && (!staff.salonName || String(staff.salonName).toLowerCase().includes('braid')));
if (!staffRows.length) throw new Error('No matching staff record named Eliza was found');

const staffIds = new Set(staffRows.map(staff => String(staff.id)));
const branches = new Map(records('branches').map(branch => [String(branch.id), String(branch.name || 'Unknown branch')]));
const appointments = records('appointments');
const inAppointmentRange = (appointment: any) => String(appointment.date || '') >= fromDate && String(appointment.date || '') <= throughDate;
const localDateTime = (value: unknown) => value ? new Date(Number(value)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }) : null;
const assignedStaffIds = (appointment: any) => new Set([
  appointment.staffId,
  ...(Array.isArray(appointment.items) ? appointment.items.map((item: any) => item.staffId) : []),
].filter(Boolean).map(String));
const reviewAppointments = appointments.filter(appointment => inAppointmentRange(appointment)
  && String(appointment.status || '').toLowerCase() === 'completed'
  && Array.from(assignedStaffIds(appointment)).some(staffId => staffIds.has(staffId)));
const targetAppointments = reviewAppointments.filter(appointment => !appointment.deletedAt);
const targetAppointmentIds = new Set(targetAppointments.map(appointment => String(appointment.id)));
const payoutItems = records('payout_items');
const lines: any[] = [];
const appointmentList = targetAppointments.map(appointment => {
  const appointmentOrders = records('orders').filter(order => String(order.appointmentId || '') === String(appointment.id) && !order.deletedAt);
  const earningLines: any[] = [];
  for (const order of appointmentOrders) {
    for (const [index, item] of (Array.isArray(order.items) ? order.items : []).entries()) {
      if (item.type !== 'service') continue;
      const primaryStaffId = item.staffId || appointment.staffId;
      const commissionItem = primaryStaffId === item.staffId ? item : { ...item, staffId: primaryStaffId };
      const roles = [
        primaryStaffId && { staffId: primaryStaffId, role: 'commission', amount: staffCommission(commissionItem, primaryStaffId), suffix: '' },
        item.coStaffId && { staffId: item.coStaffId, role: 'commission', amount: staffCommission(item, item.coStaffId), suffix: ':co-staff' },
        item.thirdStaffId && { staffId: item.thirdStaffId, role: 'commission', amount: staffCommission(item, item.thirdStaffId), suffix: ':third-staff' },
        item.helperStaffId && { staffId: item.helperStaffId, role: 'assistant', amount: Math.max(0, Number(item.assistantPayment ?? item.helperDeduction ?? 0)), suffix: ':assistant' },
      ].filter(Boolean) as any[];
      for (const earning of roles.filter(role => staffIds.has(String(role.staffId)))) {
        const itemKey = `${order.id}:${index}${earning.suffix}`;
        const line = {
          orderId: String(order.id), itemKey,
          orderDate: localDateTime(order.createdAt),
          service: String(item.name || appointment.serviceName || 'Service'),
          role: earning.role,
          amount: Math.round((Number(earning.amount) || 0) * 100) / 100,
          currency: String(item.currency || 'KES'),
          orderPaymentStatus: order.paymentStatus || order.status || null,
          payoutItems: payoutItems.filter(payout => String(payout.itemKey || '') === itemKey).map(payout => ({
            id: String(payout.id), provider: payout.provider || 'legacy', reference: payout.reference || null,
            batchId: payout.batchId || null, amount: Number(payout.commission || 0), currency: payout.currency || null,
            recordedAt: localDateTime(payout.createdAt), deletedAt: localDateTime(payout.deletedAt), deletionReason: payout.deletionReason || null,
          })),
        };
        earningLines.push(line);
        lines.push({ ...line, appointmentId: String(appointment.id), staffId: String(earning.staffId) });
      }
    }
  }
  return {
    appointmentId: String(appointment.id), date: appointment.date, time: appointment.time || null,
    cardNumber: appointment.cardNumber || null,
    customer: appointment.customerName || null,
    service: appointment.serviceName || (Array.isArray(appointment.items) ? appointment.items.map((item: any) => item.name).filter(Boolean).join(', ') : null),
    status: appointment.status,
    branch: branches.get(String(appointment.branchId || '')) || null,
    assignedStaffIds: Array.from(assignedStaffIds(appointment)),
    orderCount: appointmentOrders.length,
    orderIds: appointmentOrders.map(order => String(order.id)),
    earningLineCount: earningLines.length,
    grossByCurrency: Object.fromEntries(Array.from(new Set(earningLines.map(line => line.currency))).sort().map(currency => [currency, earningLines.filter(line => line.currency === currency).reduce((sum, line) => sum + line.amount, 0)])),
    earningLines,
  };
});

const itemKeys = new Set(lines.map(line => line.itemKey));
const payrollItems = records('payroll_items').filter(item => staffIds.has(String(item.staffId || '')) && (
  itemKeys.size > 0 && (Array.isArray(item.itemKeys) && item.itemKeys.some((key: unknown) => itemKeys.has(String(key)))) ||
  targetAppointmentIds.size > 0 && Array.isArray(item.earningLines) && item.earningLines.some((line: any) => targetAppointmentIds.has(String(line.appointmentId || '')) || itemKeys.has(String(line.itemKey || '')))
));
const batchIds = new Set(payrollItems.map(item => String(item.batchId || '')).filter(Boolean));
const payrollBatches = records('payroll_batches').filter(batch => batchIds.has(String(batch.id)));
const orderIds = new Set(lines.map(line => line.orderId));
const orderAuditEvents = orderIds.size
  ? (await sql`SELECT id, record FROM app_records WHERE collection = 'audit_logs' AND record->>'collection' IN ('order', 'orders') AND record->>'recordId' = ANY(${Array.from(orderIds)})` as any[])
    .map(row => ({ ...(row.record || {}), id: String(row.id) }))
  : [];
const reviewedAppointmentIds = reviewAppointments.map(appointment => String(appointment.id));
const appointmentAuditEvents = reviewedAppointmentIds.length
  ? (await sql`SELECT id, record FROM app_records WHERE collection = 'audit_logs' AND record->>'collection' IN ('appointment', 'appointments') AND record->>'recordId' = ANY(${reviewedAppointmentIds})` as any[])
    .map(row => ({ ...(row.record || {}), id: String(row.id) }))
  : [];
const appointmentService = (appointment: any) => String(appointment.serviceName || (Array.isArray(appointment.items)
  ? appointment.items.map((item: any) => item.name).filter(Boolean).join(', ')
  : '')).trim();
const normalize = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const deletedAppointmentReview = reviewAppointments.filter(appointment => Boolean(appointment.deletedAt)).map(appointment => {
  const service = appointmentService(appointment);
  const matchingActiveAppointments = targetAppointments.filter(candidate => candidate.date === appointment.date
    && candidate.time === appointment.time
    && normalize(candidate.customerName) === normalize(appointment.customerName)
    && normalize(appointmentService(candidate)) === normalize(service));
  const linkedOrders = records('orders').filter(order => String(order.appointmentId || '') === String(appointment.id));
  return {
    appointmentId: String(appointment.id), date: appointment.date, time: appointment.time || null,
    cardNumber: appointment.cardNumber || null, customer: appointment.customerName || null, service,
    deletedAt: localDateTime(appointment.deletedAt), deletedBy: appointment.deletedBy || null,
    linkedOrders: linkedOrders.map(order => ({
      id: String(order.id), deletedAt: localDateTime(order.deletedAt), deletedBy: order.deletedBy || null,
      voidReason: order.voidReason || null, payoutReversalRequired: Boolean(order.payoutReversalRequired),
    })),
    matchingActiveAppointments: matchingActiveAppointments.map(candidate => ({
      appointmentId: String(candidate.id), date: candidate.date, time: candidate.time || null,
      cardNumber: candidate.cardNumber || null, customer: candidate.customerName || null, service: appointmentService(candidate),
      createdAt: localDateTime(candidate.createdAt),
      orderIds: records('orders').filter(order => String(order.appointmentId || '') === String(candidate.id) && !order.deletedAt).map(order => String(order.id)),
      auditTrail: appointmentAuditEvents.filter(event => String(event.recordId || '') === String(candidate.id))
        .map(event => ({ action: event.action || null, actor: event.actor || null, at: localDateTime(event.createdAt) })),
    })),
    auditTrail: appointmentAuditEvents.filter(event => String(event.recordId || '') === String(appointment.id))
      .map(event => ({ action: event.action || null, actor: event.actor || null, at: localDateTime(event.createdAt) })),
  };
});
const orphanPayoutItems = payoutItems.filter(item => staffIds.has(String(item.staffId || ''))
  && !itemKeys.has(String(item.itemKey || ''))
  && (targetAppointmentIds.has(String(item.appointmentId || '')) || orderIds.has(String(item.orderId || ''))));

console.log(JSON.stringify({
  readOnly: true,
  period: { from: fromDate, through: throughDate, timezone: 'Africa/Nairobi' },
  staff: staffRows.map(staff => ({ id: String(staff.id), name: staff.name, branch: branches.get(String(staff.branchId || '')) || null, deleted: Boolean(staff.deletedAt) })),
  summary: {
    completedAppointments: appointmentList.length,
    appointmentsWithoutOrders: appointmentList.filter(appointment => appointment.orderCount === 0).length,
    earningLines: lines.length,
    grossByCurrency: Object.fromEntries(Array.from(new Set(lines.map(line => line.currency))).sort().map(currency => [currency, lines.filter(line => line.currency === currency).reduce((sum, line) => sum + line.amount, 0)])),
    markedPaidLines: lines.filter(line => line.payoutItems.some((payout: any) => !payout.deletedAt)).length,
    unpaidOrUnmatchedLines: lines.filter(line => !line.payoutItems.some((payout: any) => !payout.deletedAt)).length,
    orphanPayoutItems: orphanPayoutItems.length,
  },
  appointments: appointmentList,
  deletionReview: {
    completedAppointmentsNowDeleted: deletedAppointmentReview.length,
    withMatchingActiveAppointment: deletedAppointmentReview.filter(appointment => appointment.matchingActiveAppointments.length > 0).length,
    appointments: deletedAppointmentReview,
  },
  payrollItems: payrollItems.map(item => ({
    id: String(item.id), batchId: item.batchId || null, provider: item.provider || 'mpesa', staffId: String(item.staffId), staffName: item.staffName || null,
    status: item.status || null, amountKES: item.amountKES ?? null, currency: item.currency || 'KES',
    createdAt: localDateTime(item.createdAt), paidAt: localDateTime(item.paidAt), reversedAt: localDateTime(item.reversedAt),
    reference: item.reference || null, transferCode: item.transferCode || null, conversationId: item.conversationId || null,
    failureReason: item.failureReason || item.error || item.webhookIssue || null,
    itemKeys: Array.isArray(item.itemKeys) ? item.itemKeys.filter((key: unknown) => itemKeys.has(String(key))) : [],
    earningLines: Array.isArray(item.earningLines) ? item.earningLines.filter((line: any) => staffIds.has(String(line.staffId || ''))
      && (itemKeys.has(String(line.itemKey || '')) || targetAppointmentIds.has(String(line.appointmentId || '')))).map((line: any) => ({
      appointmentId: line.appointmentId || null, orderId: line.orderId || null, itemKey: line.itemKey || null,
      service: line.serviceName || null, role: line.role || null, amount: line.amount ?? null, currency: line.currency || null,
      orderDate: localDateTime(line.createdAt),
    })) : [],
  })),
  payrollBatches: payrollBatches.map(batch => ({ id: String(batch.id), provider: batch.provider || 'mpesa', status: batch.status || null, totalKES: batch.totalKES ?? null, createdAt: localDateTime(batch.createdAt), updatedAt: localDateTime(batch.updatedAt) })),
  orderAuditEvents: orderAuditEvents.map(event => {
    const snapshot = event.recordSnapshot && typeof event.recordSnapshot === 'object' ? event.recordSnapshot : null;
    const snapshotLines = (Array.isArray(snapshot?.items) ? snapshot.items : []).filter((item: any) => item.type === 'service'
      && [item.staffId, item.coStaffId, item.thirdStaffId, item.helperStaffId].some((id: unknown) => staffIds.has(String(id || ''))));
    return {
      action: event.action || null, actor: event.actor || null, eventAt: localDateTime(event.createdAt), orderId: String(event.recordId),
      snapshotDeletedAt: localDateTime(snapshot?.deletedAt), snapshotUpdatedAt: localDateTime(snapshot?.updatedAt),
      snapshotServices: snapshotLines.map((item: any) => ({ service: item.name || null, staffId: item.staffId || null, commission: item.commission ?? null, commissionPct: item.commissionPct ?? item.commissionRate ?? null, amount: item.lineTotalAfterDiscount ?? item.price ?? null })),
    };
  }),
  orphanPayoutItems: orphanPayoutItems.map(item => ({ id: String(item.id), orderId: item.orderId || null, itemKey: item.itemKey || null, amount: item.commission ?? null, currency: item.currency || null, provider: item.provider || 'legacy', reference: item.reference || null, deletedAt: localDateTime(item.deletedAt), deletionReason: item.deletionReason || null })),
}, null, 2));