import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings, previousSaturdayThroughYesterdayRange } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const collections = ['accounts', 'branches', 'staff', 'appointments', 'orders', 'payout_items', 'payout_batches', 'payroll_items', 'payroll_batches', 'audit_logs'];
const rowsByCollection = Object.fromEntries(await Promise.all(collections.map(async collection => [
  collection,
  await sql`SELECT id, tenant_id, created_at, record FROM app_records WHERE collection = ${collection}` as { id: string; tenant_id: string | null; created_at: string; record: Record<string, any> }[],
]))) as Record<string, { id: string; tenant_id: string | null; created_at: string; record: Record<string, any> }[]>;
const records = (collection: string) => rowsByCollection[collection].map(row => ({
  ...row.record,
  id: row.id,
  tenantId: row.record.tenantId || row.tenant_id,
  dbInsertedAt: row.created_at,
}));
const ownerAccounts = records('accounts').filter(account => String(account.name || '').trim().toLowerCase() === 'esther muthoni'
  && String(account.role || '').toLowerCase() === 'owner'
  && String(account.salonName || '').toLowerCase().includes('braid'));
if (ownerAccounts.length !== 1) throw new Error(`Expected one matching salon owner, found ${ownerAccounts.length}`);

const tenantId = String(ownerAccounts[0].tenantId || '');
const mainBranches = records('branches').filter(branch => String(branch.name || '').trim().toLowerCase() === 'main branch'
  && String(branch.salonId || branch.tenantId || '') === tenantId);
if (mainBranches.length !== 1) throw new Error(`Expected one Main Branch for the salon, found ${mainBranches.length}`);
const branchId = String(mainBranches[0].id);
const captureTime = new Date('2026-10-31T18:27:00+03:00');
const asOf = new Date();
const desiredPeriod = previousSaturdayThroughYesterdayRange(asOf);
const todayStart = desiredPeriod.to;
const sundayStart = desiredPeriod.from + 24 * 60 * 60 * 1000;
const screenshotPeriod = { from: sundayStart, to: asOf.getTime() + 1 };
const previousPayrollPeriod = { from: sundayStart, to: todayStart };
const tenantStaff = records('staff').filter(staff => staff.tenantId === tenantId && !staff.deletedAt);
const eligibleStaff = tenantStaff.filter(staff => staff.branchId === branchId && staff.employmentStatus !== 'laid-off');
const eligibleStaffById = new Map(eligibleStaff.map(staff => [String(staff.id), staff]));
const tenantAppointments = records('appointments').filter(appointment => appointment.tenantId === tenantId);
const appointmentsById = new Map(tenantAppointments.filter(appointment => !appointment.deletedAt).map(appointment => [String(appointment.id), appointment]));
const tenantOrders = records('orders').filter(order => order.tenantId === tenantId);
const tenantPayoutItems = records('payout_items').filter(item => item.tenantId === tenantId);
const tenantPayoutBatches = records('payout_batches').filter(item => item.tenantId === tenantId);
const tenantPayrollItems = records('payroll_items').filter(item => item.tenantId === tenantId);
const tenantPaystackItems = tenantPayrollItems.filter(item => item.provider === 'paystack');
const tenantPayrollBatches = records('payroll_batches').filter(item => item.tenantId === tenantId);
const tenantAuditLogs = records('audit_logs').filter(item => item.tenantId === tenantId);

const oldPayrollOrders = tenantOrders.filter(order => !order.branchId || order.branchId === branchId);
const oldReportOrders = oldPayrollOrders.filter(order => {
  const appointment = appointmentsById.get(String(order.appointmentId || ''));
  const resolvedBranchId = order.branchId || appointment?.branchId;
  return !resolvedBranchId || resolvedBranchId === branchId;
});
const newBranchOrders = tenantOrders.filter(order => {
  if (order.branchId) return order.branchId === branchId;
  const appointment = appointmentsById.get(String(order.appointmentId || ''));
  if (appointment?.branchId) return appointment.branchId === branchId;
  return (Array.isArray(order.items) ? order.items : []).some((item: any) => [item.staffId, item.coStaffId, item.thirdStaffId, item.helperStaffId]
    .some(staffId => eligibleStaffById.get(String(staffId || ''))?.branchId === branchId));
});
const oldBranchPayoutItems = tenantPayoutItems.filter(item => !item.branchId || item.branchId === branchId);
const activePayoutKeys = new Set(oldBranchPayoutItems.filter(item => !item.deletedAt).map(item => String(item.itemKey || '')));
const calculateLines = (orders: any[], payoutItems: any[], period: { from: number; to: number }) => calculateUnpaidStaffEarnings(
  orders, payoutItems, tenantAppointments, period.from, period.to,
).filter(line => eligibleStaffById.has(line.staffId));
const sum = (lines: { amount: number }[]) => lines.reduce((total, line) => total + line.amount, 0);
const currencyTotals = (lines: { amount: number; currency: string }[]) => Object.fromEntries(
  Array.from(new Set(lines.map(line => line.currency))).sort().map(currency => [currency, sum(lines.filter(line => line.currency === currency))]),
);
const roundedStaffTotal = (lines: { amount: number; staffId: string }[]) => {
  const totals = new Map<string, number>();
  for (const line of lines) totals.set(line.staffId, (totals.get(line.staffId) || 0) + line.amount);
  return Array.from(totals.values()).reduce((total, amount) => total + Math.round(amount), 0);
};

const screenshotGrossLines = calculateLines(oldReportOrders, [], screenshotPeriod);
const captureGrossLines = calculateLines(oldReportOrders, [], { from: screenshotPeriod.from, to: captureTime.getTime() + 1 });
const reportPreviousGrossLines = calculateLines(oldReportOrders, [], previousPayrollPeriod);
const payrollPreviousGrossLines = calculateLines(oldPayrollOrders, [], previousPayrollPeriod);
const previousPaidLines = payrollPreviousGrossLines.filter(line => activePayoutKeys.has(line.itemKey));
const previousUnpaidLines = calculateLines(oldPayrollOrders, oldBranchPayoutItems, previousPayrollPeriod);
const todayGrossLines = screenshotGrossLines.filter(line => line.createdAt >= todayStart);
const oldPaystackDisplayTotal = roundedStaffTotal(previousUnpaidLines);
const oldUiRecipients = eligibleStaff.filter(staff => roundedStaffTotal(previousUnpaidLines.filter(line => line.staffId === String(staff.id))) > 0);
const oldUiRecipientIds = new Set(oldUiRecipients.map(staff => String(staff.id)));
const senderStaffById = new Map(oldUiRecipients.map(staff => [String(staff.id), staff]));
const oldSendOrders = tenantOrders.filter(order => {
  if (order.branchId) return order.branchId === branchId;
  const appointment = appointmentsById.get(String(order.appointmentId || ''));
  if (appointment?.branchId) return appointment.branchId === branchId;
  return (Array.isArray(order.items) ? order.items : []).some((item: any) => [item.staffId, item.coStaffId, item.thirdStaffId, item.helperStaffId]
    .some(staffId => senderStaffById.get(String(staffId || ''))?.branchId === branchId));
});
const oldSendLines = calculateLines(oldSendOrders, oldBranchPayoutItems, previousPayrollPeriod)
  .filter(line => oldUiRecipientIds.has(line.staffId) && line.currency === 'KES');
const oldPaystackServerKES = roundedStaffTotal(oldSendLines);
const desiredGrossLines = calculateLines(newBranchOrders, [], desiredPeriod);
const desiredUnpaidLines = calculateLines(newBranchOrders, oldBranchPayoutItems, desiredPeriod)
  .filter(line => line.currency === 'KES');
const desiredPaystackKES = roundedStaffTotal(desiredUnpaidLines);
const currentWindowUnpaidLines = calculateLines(newBranchOrders, oldBranchPayoutItems, screenshotPeriod)
  .filter(line => line.currency === 'KES');
const currentWindowPaystackKES = roundedStaffTotal(currentWindowUnpaidLines);
const desiredKeys = new Set(desiredGrossLines.filter(line => line.currency === 'KES').map(line => line.itemKey));
const reversedItems = tenantPaystackItems.filter(item => item.status === 'reversed'
  && (Array.isArray(item.itemKeys) ? item.itemKeys : []).some((key: unknown) => desiredKeys.has(String(key))));
const allMainBranchReversedItems = tenantPayrollItems.filter(item => item.status === 'reversed'
  && (item.branchId === branchId || (!item.branchId && eligibleStaffById.has(String(item.staffId || '')))));
const mainBranchReversedPayoutItems = tenantPayoutItems.filter(item => item.deletedAt
  && /revers/i.test(String(item.deletionReason || ''))
  && (!item.branchId || item.branchId === branchId));
const mainBranchReversedBatches = [...tenantPayoutBatches, ...tenantPayrollBatches].filter(item => item.status === 'reversed'
  && !item.deletedAt
  && (!item.branchId || item.branchId === branchId));
const reversedKeys = new Set(reversedItems.flatMap(item => Array.isArray(item.itemKeys) ? item.itemKeys.map(String) : []));
const reopenedReversalLines = desiredUnpaidLines.filter(line => reversedKeys.has(line.itemKey));
const ordersInsertedAfterCapture = oldReportOrders.filter(order => new Date(order.dbInsertedAt).getTime() > captureTime.getTime()
  && Number(order.createdAt || 0) >= screenshotPeriod.from && Number(order.createdAt || 0) < screenshotPeriod.to);
const insertedAfterCaptureLines = calculateLines(ordersInsertedAfterCapture, [], screenshotPeriod);
const ordersDeletedAfterCapture = oldReportOrders.filter(order => Number(order.deletedAt || 0) > captureTime.getTime()
  && Number(order.deletedAt || 0) <= asOf.getTime()
  && Number(order.createdAt || 0) >= screenshotPeriod.from && Number(order.createdAt || 0) < captureTime.getTime());
const deletedOrderLines = calculateLines(ordersDeletedAfterCapture.map(({ deletedAt: _deletedAt, ...order }) => order), [], screenshotPeriod);
const deletedOrderDetails = ordersDeletedAfterCapture.map(order => {
  const { deletedAt, ...activeOrder } = order;
  return {
    orderId: order.id,
    orderCreatedAt: new Date(Number(order.createdAt)).toISOString(),
    deletedAt: new Date(Number(deletedAt)).toISOString(),
    earningLines: calculateLines([activeOrder], [], screenshotPeriod).map(line => ({
      staff: eligibleStaffById.get(line.staffId)?.name || 'Unknown staff',
      service: line.serviceName,
      role: line.role,
      amountKES: line.currency === 'KES' ? line.amount : null,
      currency: line.currency,
    })),
  };
});
const insertedOrderDetails = ordersInsertedAfterCapture.map(order => ({
  orderId: order.id,
  orderCreatedAt: new Date(Number(order.createdAt)).toISOString(),
  databaseInsertedAt: new Date(order.dbInsertedAt).toISOString(),
  earningLines: calculateLines([order], [], screenshotPeriod).map(line => ({
    staff: eligibleStaffById.get(line.staffId)?.name || 'Unknown staff',
    service: line.serviceName,
    role: line.role,
    amountKES: line.currency === 'KES' ? line.amount : null,
    currency: line.currency,
  })),
}));
const orderById = new Map(tenantOrders.map(order => [String(order.id), order]));
const postCaptureOrderAudits = tenantAuditLogs.filter(log => Number(log.createdAt || 0) > captureTime.getTime()
  && Number(log.createdAt || 0) <= asOf.getTime()
  && ['order', 'orders'].includes(String(log.collection || '').toLowerCase()))
  .map(log => {
    const currentOrder = orderById.get(String(log.recordId || ''));
    const snapshot = log.recordSnapshot && typeof log.recordSnapshot === 'object'
      ? { ...log.recordSnapshot, id: String(log.recordId || log.recordSnapshot.id || '') }
      : null;
    const snapshotLines = snapshot ? calculateLines([snapshot], [], screenshotPeriod) : [];
    const currentLines = currentOrder ? calculateLines([currentOrder], [], screenshotPeriod) : [];
    return {
      action: log.action,
      eventAt: new Date(Number(log.createdAt)).toISOString(),
      orderId: log.recordId,
      snapshotEarnings: summarizeReportLines(snapshotLines),
      currentEarnings: summarizeReportLines(currentLines),
    };
  });
function summarizeReportLines(lines: any[]) {
  return lines.reduce((summary, line) => {
  const order = orderById.get(String(line.orderId));
  const itemIndex = Number(String(line.itemKey).split(':')[1]);
  const item = Number.isInteger(itemIndex) ? order?.items?.[itemIndex] : null;
  const revenue = Number(item?.lineTotalAfterDiscount ?? Number(item?.price || 0) * Number(item?.qty || 1)) || 0;
  const helperDeduction = Math.max(0, Number(item?.assistantPayment ?? item?.helperDeduction ?? 0));
  summary.count += 1;
  summary.revenue += revenue;
  summary.helperDeductions += helperDeduction;
  if (line.role === 'assistant') summary.assistant += line.amount;
  else summary.commission += line.amount;
  return summary;
  }, { count: 0, revenue: 0, helperDeductions: 0, commission: 0, assistant: 0 });
}
const screenTotal = Math.round(sum(screenshotGrossLines));
const previousReportGross = sum(reportPreviousGrossLines);
const previousPayrollGross = sum(payrollPreviousGrossLines);
const scopeDifference = previousReportGross - previousPayrollGross;
const screenshotRounding = screenTotal - sum(screenshotGrossLines);
const payrollRounding = oldPaystackDisplayTotal - sum(previousUnpaidLines);
const roundingDifference = screenshotRounding - payrollRounding;
const difference = screenTotal - oldPaystackDisplayTotal;
const sumField = (items: any[], field: string) => items.reduce((total, item) => total + Number(item[field] || 0), 0);
const reversalReasonCounts = Object.fromEntries(Array.from(new Set(mainBranchReversedPayoutItems.map(item => String(item.deletionReason || 'unspecified'))))
  .map(reason => [reason, mainBranchReversedPayoutItems.filter(item => String(item.deletionReason || 'unspecified') === reason).length]));

const staffSummary = eligibleStaff.map(staff => {
  const staffLines = (lines: any[]) => lines.filter(line => line.staffId === String(staff.id));
  const screenshotLines = staffLines(screenshotGrossLines);
  const previousGross = staffLines(payrollPreviousGrossLines);
  const previousUnpaid = staffLines(previousUnpaidLines);
  const desiredUnpaid = staffLines(desiredUnpaidLines);
  return {
    staff: staff.name,
    screenshotGrossAllCurrencies: sum(screenshotLines),
    screenshotGrossKES: sum(screenshotLines.filter(line => line.currency === 'KES')),
    previousPeriodPaidKES: sum(staffLines(previousPaidLines).filter(line => line.currency === 'KES')),
    previousPeriodUnpaidKES: sum(previousUnpaid.filter(line => line.currency === 'KES')),
    targetPeriodUnpaidKES: sum(desiredUnpaid),
    targetPaystackAmountKES: Math.round(sum(desiredUnpaid)),
    previousPeriodGrossAllCurrencies: sum(previousGross),
  };
}).filter(row => row.screenshotGrossAllCurrencies || row.previousPeriodPaidKES || row.targetPeriodUnpaidKES)
  .sort((first, second) => first.staff.localeCompare(second.staff));

console.log(JSON.stringify({
  readOnly: true,
  reference: { asOf: asOf.toISOString(), branch: 'Main Branch', tenantId },
  periods: {
    earlierScreenshotCapture: captureTime.toISOString(),
    latestSnapshot: asOf.toISOString(),
    screenshotTable: { from: new Date(screenshotPeriod.from).toISOString(), through: asOf.toISOString() },
    previousPayroll: { from: new Date(previousPayrollPeriod.from).toISOString(), through: new Date(previousPayrollPeriod.to - 1).toISOString() },
    requestedSaturdayThroughYesterday: { from: new Date(desiredPeriod.from).toISOString(), through: new Date(desiredPeriod.to - 1).toISOString() },
  },
  screenshotReconciliation: {
    screenshotTotalFromAttachmentKES: 289318,
    earlierScreenshotLineCount: 666,
    calculatedAtEarlierScreenshot: summarizeReportLines(captureGrossLines),
    calculatedUpperTableTotal: screenTotal,
    calculatedCurrentLineCount: screenshotGrossLines.length,
    differenceBetweenScreenshots: screenTotal - 289318,
    ordersInsertedSinceEarlierScreenshot: ordersInsertedAfterCapture.length,
    earningsFromOrdersInsertedSinceEarlierScreenshot: summarizeReportLines(insertedAfterCaptureLines),
    insertedOrderDetails,
    ordersDeletedAfterEarlierScreenshot: ordersDeletedAfterCapture.length,
    earningsFromOrdersDeletedAfterEarlierScreenshot: summarizeReportLines(deletedOrderLines),
    deletedOrderDetails,
    postCaptureOrderAuditEvents: postCaptureOrderAudits,
    oldPaystackDisplayedTotalFromAttachmentKES: 222682,
    calculatedOldPaystackDisplayTotal: oldPaystackDisplayTotal,
    calculatedDifference: difference,
    oldPaystackServerKESOnlyTotal: oldPaystackServerKES,
    sourceBreakdown: {
      todayGrossAllCurrencies: sum(todayGrossLines),
      alreadyPaidPreviousPeriodByCurrency: currencyTotals(previousPaidLines),
      previousPeriodGrossByCurrency: currencyTotals(payrollPreviousGrossLines),
      branchScopeDifference: scopeDifference,
      roundingDifference,
      componentsSum: sum(todayGrossLines) + sum(previousPaidLines) + scopeDifference + roundingDifference,
    },
  },
  requestedPeriod: {
    grossByCurrency: currencyTotals(desiredGrossLines),
    unpaidKESBeforePerStaffRounding: sum(desiredUnpaidLines),
    paystackTotalKES: desiredPaystackKES,
    reopenedReversalAmountCurrentlyUnpaidKES: sum(reopenedReversalLines),
    reversedPaystackItems: reversedItems.map(item => ({
      staff: item.staffName,
      amountKES: Number(item.amountKES || 0),
      reversedAt: item.reversedAt ? new Date(Number(item.reversedAt)).toISOString() : null,
      batchId: item.batchId,
    })),
    allMainBranchReversedPayrollItems: {
      count: allMainBranchReversedItems.length,
      totalKES: sumField(allMainBranchReversedItems, 'amountKES'),
      earliestReversedAt: allMainBranchReversedItems.length ? new Date(Math.min(...allMainBranchReversedItems.map(item => Number(item.reversedAt || item.createdAt || 0)))).toISOString() : null,
      latestReversedAt: allMainBranchReversedItems.length ? new Date(Math.max(...allMainBranchReversedItems.map(item => Number(item.reversedAt || item.createdAt || 0)))).toISOString() : null,
    },
    reversalPayoutAuditItems: {
      count: mainBranchReversedPayoutItems.length,
      totalKES: sumField(mainBranchReversedPayoutItems, 'commission'),
      deletionDates: Array.from(new Set(mainBranchReversedPayoutItems.map(item => item.deletedAt ? new Date(Number(item.deletedAt)).toISOString().slice(0, 10) : 'unknown'))).sort(),
      reasonCounts: reversalReasonCounts,
    },
    reversedBatchSummaries: {
      count: mainBranchReversedBatches.length,
      totalKES: sumField(mainBranchReversedBatches, 'totalKES'),
      providers: Array.from(new Set(mainBranchReversedBatches.map(item => item.provider || 'legacy payout'))).sort(),
    },
  },
  currentSundayThroughNow: {
    grossByCurrency: currencyTotals(calculateLines(newBranchOrders, [], screenshotPeriod)),
    unpaidKES: sum(currentWindowUnpaidLines),
    paystackTotalKES: currentWindowPaystackKES,
  },
  staff: staffSummary,
}, null, 2));