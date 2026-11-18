import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { calculateUnpaidStaffEarnings, staffCommission } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const from = Date.parse('2026-11-01T00:00:00+03:00');
const to = Date.parse('2026-11-07T00:00:00+03:00');
const sql = neon(databaseUrl);
const loadRows = async (collection: string) => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = ${collection}
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
` as any[];
const [staffRows, branchRows, appointmentRows, orderRows, payoutRows] = await Promise.all([
  loadRows('staff'), loadRows('branches'), loadRows('appointments'), loadRows('orders'), loadRows('payout_items'),
]);
const records = (rows: any[]) => rows.map(row => ({
  ...row.record,
  id: String(row.id),
  tenantId: row.record?.tenantId || row.tenant_id,
}));
const staff = records(staffRows);
const branches = records(branchRows);
const appointments = records(appointmentRows);
const orders = records(orderRows);
const payoutItems = records(payoutRows);
const staffById = new Map(staff.map(member => [String(member.id), member]));
const branchById = new Map(branches.map(branch => [String(branch.id), String(branch.name || branch.id)]));
const appointmentsById = new Map(appointments.filter(item => !item.deletedAt).map(item => [String(item.id), item]));
const ordersById = new Map(orders.map(order => [String(order.id), order]));

const grossLines = calculateUnpaidStaffEarnings(orders, [], appointments, from, to);
const unpaidLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, from, to);
const activePayouts = payoutItems.filter(item => !item.deletedAt);
const activePaidKeys = new Set(activePayouts.map(item => String(item.itemKey || '')));
const paidLines = grossLines.filter(line => activePaidKeys.has(line.itemKey));
const now = Date.now();
const dateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date(now));
const datePart = (type: string) => Number(dateParts.find(value => value.type === type)?.value);
const todayStart = Date.UTC(datePart('year'), datePart('month') - 1, datePart('day')) - 3 * 60 * 60 * 1000;
const dashboardLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, from, now + 1)
  .filter(line => line.currency === 'KES');
const normalize = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const stableStringify = (value: any): string => Array.isArray(value)
  ? `[${value.map(stableStringify).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sum = (lines: { amount: number }[]) => lines.reduce((total, line) => total + Number(line.amount || 0), 0);

const summaries = new Map<string, any>();
const ensureSummary = (staffId: string) => {
  let summary = summaries.get(staffId);
  if (!summary) {
    const member = staffById.get(staffId);
    summary = {
      staffId,
      name: member?.name || 'Former or unlinked staff',
      branch: branchById.get(String(member?.branchId || '')) || member?.branchName || member?.branch || null,
      employmentStatus: member?.employmentStatus || null,
      deletedStaffRecord: Boolean(member?.deletedAt),
      grossByCurrency: {}, paidByCurrency: {}, unpaidByCurrency: {},
      commissionByCurrency: {}, assistantByCurrency: {}, lineCount: 0,
    };
    summaries.set(staffId, summary);
  }
  return summary;
};
for (const member of staff.filter(item => !item.deletedAt)) ensureSummary(String(member.id));

const dashboardByStaff = new Map<string, any>();
for (const line of dashboardLines) {
  const summary = dashboardByStaff.get(line.staffId) || { commission: 0, assistant: 0, today: 0, lineCount: 0 };
  const field = line.role === 'assistant' ? 'assistant' : 'commission';
  summary[field] += line.amount;
  if (line.createdAt >= todayStart) summary.today += line.amount;
  summary.lineCount += 1;
  dashboardByStaff.set(line.staffId, summary);
}

const lines = grossLines.map(line => {
  const order = ordersById.get(line.orderId);
  const itemIndex = Number(line.itemKey.slice(line.orderId.length + 1).split(':')[0]);
  const item = order?.items?.[itemIndex] || {};
  const appointment = appointmentsById.get(String(order?.appointmentId || ''));
  const member = staffById.get(line.staffId);
  const payoutMatches = activePayouts.filter(payout => String(payout.itemKey || '') === line.itemKey);
  const summary = ensureSummary(line.staffId);
  const currency = line.currency;
  const paid = payoutMatches.length > 0;
  summary.lineCount += 1;
  summary.grossByCurrency[currency] = (summary.grossByCurrency[currency] || 0) + line.amount;
  const paidOrUnpaid = paid ? summary.paidByCurrency : summary.unpaidByCurrency;
  paidOrUnpaid[currency] = (paidOrUnpaid[currency] || 0) + line.amount;
  const roleTotals = line.role === 'assistant' ? summary.assistantByCurrency : summary.commissionByCurrency;
  roleTotals[currency] = (roleTotals[currency] || 0) + line.amount;
  return {
    staffId: line.staffId,
    staffName: member?.name || item[`${line.role === 'assistant' ? 'helper' : 'staff'}StaffName`] || 'Former or unlinked staff',
    branch: branchById.get(String(order?.branchId || appointment?.branchId || member?.branchId || '')) || null,
    role: line.role,
    amount: line.amount,
    currency,
    service: line.serviceName,
    customer: order?.customerName || appointment?.customerName || 'Walk-in Customer',
    orderId: line.orderId,
    itemKey: line.itemKey,
    orderCreatedAt: line.createdAt,
    appointmentId: appointment?.id || order?.appointmentId || null,
    appointmentDate: appointment?.date || null,
    appointmentTime: appointment?.time || null,
    paid,
    activePayoutCount: payoutMatches.length,
    payoutAmounts: payoutMatches.map(payout => Number(payout.commission || 0)),
    sourceAssistantPayment: Number(item.assistantPayment ?? item.helperDeduction ?? 0),
    sourceCommission: Number(line.role === 'assistant'
      ? 0
      : item[line.itemKey.endsWith(':co-staff') ? 'coStaffCommission'
        : line.itemKey.endsWith(':third-staff') ? 'thirdStaffCommission'
          : 'primaryCommission'] ?? item.commission ?? 0),
  };
});

const payoutMarkerCounts = new Map<string, any[]>();
for (const payout of activePayouts) {
  const key = String(payout.itemKey || '');
  if (!key) continue;
  const matches = payoutMarkerCounts.get(key) || [];
  matches.push(payout);
  payoutMarkerCounts.set(key, matches);
}
const duplicatePayoutMarkers = Array.from(payoutMarkerCounts.entries()).filter(([, matches]) => matches.length > 1)
  .map(([itemKey, matches]) => ({ itemKey, payoutIds: matches.map(item => String(item.id)), amounts: matches.map(item => Number(item.commission || 0)) }));
const payoutMismatches = lines.filter(line => line.activePayoutCount === 1 && (
  line.payoutAmounts[0] !== line.amount
  || activePayouts.find(payout => String(payout.itemKey || '') === line.itemKey)?.staffId !== line.staffId
));

const ordersInPeriod = orders.filter(order => !order.deletedAt && Number(order.createdAt || 0) >= from && Number(order.createdAt || 0) < to);
const generatedByKey = new Map(grossLines.map(line => [line.itemKey, line]));
const expectedEarningKeys = new Set<string>();
const serviceItemMismatches: any[] = [];
for (const order of ordersInPeriod) {
  const appointment = appointmentsById.get(String(order.appointmentId || '')) as any;
  for (const [index, item] of (Array.isArray(order.items) ? order.items : []).entries()) {
    if (item.type !== 'service') continue;
    const baseKey = `${order.id}:${index}`;
    const primaryStaffId = item.staffId || appointment?.staffId;
    const expected: any[] = [];
    if (primaryStaffId) {
      const commissionItem = primaryStaffId === item.staffId ? item : { ...item, staffId: primaryStaffId };
      expected.push({ itemKey: baseKey, staffId: String(primaryStaffId), role: 'commission', amount: staffCommission(commissionItem, primaryStaffId) });
    }
    if (item.coStaffId) expected.push({ itemKey: `${baseKey}:co-staff`, staffId: String(item.coStaffId), role: 'commission', amount: staffCommission(item, item.coStaffId) });
    if (item.thirdStaffId) expected.push({ itemKey: `${baseKey}:third-staff`, staffId: String(item.thirdStaffId), role: 'commission', amount: staffCommission(item, item.thirdStaffId) });
    if (item.helperStaffId) expected.push({
      itemKey: `${baseKey}:assistant`, staffId: String(item.helperStaffId), role: 'assistant',
      amount: Math.max(0, Number(item.assistantPayment ?? item.helperDeduction ?? 0)),
    });
    for (const line of expected) {
      expectedEarningKeys.add(line.itemKey);
      const actual = generatedByKey.get(line.itemKey);
      if (!actual || actual.staffId !== line.staffId || actual.role !== line.role || actual.amount !== line.amount) {
        serviceItemMismatches.push({ orderId: String(order.id), service: item.name || 'Service', ...line, actual: actual ? { staffId: actual.staffId, role: actual.role, amount: actual.amount } : null });
      }
    }
    if (!expected.length) serviceItemMismatches.push({ orderId: String(order.id), service: item.name || 'Service', issue: 'service item has no assigned earning staff' });
  }
}
const unexpectedEarningLines = grossLines.filter(line => !expectedEarningKeys.has(line.itemKey));
const completedAppointments = appointments.filter(item => !item.deletedAt && item.status === 'completed'
  && String(item.date || '') >= '2026-11-01' && String(item.date || '') < '2026-11-07');
const activeOrdersByAppointment = new Map<string, any[]>();
for (const order of orders.filter(item => !item.deletedAt && item.appointmentId)) {
  const linked = activeOrdersByAppointment.get(String(order.appointmentId)) || [];
  linked.push(order);
  activeOrdersByAppointment.set(String(order.appointmentId), linked);
}
const earningOrderIds = new Set(grossLines.map(line => line.orderId));
const completedAppointmentsWithoutOrders = completedAppointments.filter(item => !activeOrdersByAppointment.has(String(item.id)))
  .map(item => ({
    id: String(item.id), date: item.date, time: item.time || null, customer: item.customerName || null,
    service: item.serviceName || null, status: item.status,
    assignedStaff: [item.staffId && { id: String(item.staffId), name: item.staffName || null },
      ...(Array.isArray(item.items) ? item.items.map((service: any) => service.staffId && ({ id: String(service.staffId), name: service.staffName || null })) : [])]
      .filter(Boolean),
    linkedOrdersIncludingDeleted: orders.filter(order => String(order.appointmentId || '') === String(item.id)).map(order => ({
      id: String(order.id), deletedAt: order.deletedAt || null, deletedBy: order.deletedBy || null,
      voidReason: order.voidReason || null, createdAt: Number(order.createdAt || 0),
      totalByCurrency: order.totalByCurrency || {},
    })),
  }));
const completedAppointmentsWithoutWindowEarnings = completedAppointments.filter(item => {
  const linkedOrders = activeOrdersByAppointment.get(String(item.id)) || [];
  return linkedOrders.length > 0 && !linkedOrders.some(order => earningOrderIds.has(String(order.id)));
}).map(item => ({
  id: String(item.id), date: item.date, time: item.time || null, customer: item.customerName || null,
  orderIds: (activeOrdersByAppointment.get(String(item.id)) || []).map(order => String(order.id)),
  orderDates: (activeOrdersByAppointment.get(String(item.id)) || []).map(order => new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false })),
}));
const dashboardOrderIds = new Set(dashboardLines.map(line => line.orderId));
const completedAppointmentsCoveredByDashboardToday = completedAppointmentsWithoutWindowEarnings.filter(item =>
  item.orderIds.some(orderId => dashboardOrderIds.has(orderId)));
const completedAppointmentsWithMultipleOrders = completedAppointments.filter(item => (activeOrdersByAppointment.get(String(item.id)) || []).length > 1)
  .map(item => ({
    id: String(item.id), date: item.date,
    appointmentServiceName: item.serviceName || null,
    appointmentItems: (item.items || []).map((service: any) => ({ serviceName: service.serviceName || null, staffName: service.staffName || null })),
    orders: (activeOrdersByAppointment.get(String(item.id)) || []).map(order => ({
      id: String(order.id), createdAt: new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
      totalByCurrency: order.totalByCurrency || {}, paymentMethod: order.paymentMethod || null,
      items: (order.items || []).map((service: any) => ({
        type: service.type, name: service.name, price: service.price, qty: service.qty || 1,
        staffName: service.staffName || null, helperStaffName: service.helperStaffName || null,
        commission: service.commission || 0, assistantPayment: service.assistantPayment ?? service.helperDeduction ?? 0,
      })),
      earnings: lines.filter(line => line.orderId === String(order.id)).map(line => ({ staffName: line.staffName, role: line.role, service: line.service, amount: line.amount })),
    })),
  }));
const windowOrdersWithMissingAppointment = ordersInPeriod.filter(order => order.appointmentId && !appointmentsById.has(String(order.appointmentId)))
  .map(order => {
    const appointment = appointments.find(item => String(item.id) === String(order.appointmentId));
    return {
      orderId: String(order.id), appointmentId: String(order.appointmentId),
      appointment: appointment ? { date: appointment.date, time: appointment.time || null, status: appointment.status, deletedAt: appointment.deletedAt || null, deletedBy: appointment.deletedBy || null } : null,
      order: {
        customer: order.customerName || 'Walk-in Customer', totalByCurrency: order.totalByCurrency || {},
        items: (order.items || []).map((service: any) => ({ type: service.type, name: service.name, staffName: service.staffName || null, helperStaffName: service.helperStaffName || null, commission: service.commission || 0, assistantPayment: service.assistantPayment ?? service.helperDeduction ?? 0 })),
      },
      earnings: lines.filter(line => line.orderId === String(order.id)).map(line => ({ staffName: line.staffName, role: line.role, service: line.service, amount: line.amount })),
    };
  });
const earningLinesWithNoLiveAppointment = grossLines.filter(line => {
  const order = ordersById.get(line.orderId);
  return Boolean(order?.appointmentId && !appointmentsById.has(String(order.appointmentId)));
}).map(line => ({ orderId: line.orderId, itemKey: line.itemKey, staffId: line.staffId, service: line.serviceName }));
const reconciliationOrderIds = Array.from(new Set([
  ...completedAppointmentsWithMultipleOrders.flatMap(item => item.orders.map(order => order.id)),
  ...windowOrdersWithMissingAppointment.map(order => order.orderId),
  ...completedAppointmentsWithoutOrders.flatMap(item => item.linkedOrdersIncludingDeleted.map(order => order.id)),
]));
const reconciliationAppointmentIds = Array.from(new Set([
  ...completedAppointmentsWithMultipleOrders.map(item => item.id),
  ...windowOrdersWithMissingAppointment.map(order => order.appointmentId),
  ...completedAppointmentsWithoutOrders.map(item => item.id),
]));
const reconciliationRecordIds = [...reconciliationOrderIds, ...reconciliationAppointmentIds];
const reconciliationAuditRows = reconciliationRecordIds.length ? await sql`
  SELECT
    record->>'recordId' AS record_id,
    record->>'collection' AS record_collection,
    record->>'action' AS action,
    record->>'actor' AS actor,
    record->>'createdAt' AS event_created_at,
    record->>'summary' AS summary,
    record->'recordSnapshot'->>'deletedAt' AS snapshot_deleted_at,
    record->'recordSnapshot'->>'status' AS snapshot_status
  FROM app_records
  WHERE collection = 'audit_logs'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'recordId' = ANY(${reconciliationRecordIds})
    AND record->>'collection' IN ('order', 'orders', 'appointment', 'appointments')
` as any[] : [];
const duplicateOrderGroups = new Map<string, any[]>();
for (const order of ordersInPeriod) {
  if (!order.appointmentId) continue;
  const appointment = appointmentsById.get(String(order.appointmentId || ''));
  const signature = stableStringify({
    appointmentId: order.appointmentId || null,
    customerId: order.customerId || null,
    customerName: normalize(order.customerName),
    branchId: order.branchId || appointment?.branchId || null,
    paymentMethod: order.paymentMethod || null,
    mpesaReceiptNumber: order.mpesaReceiptNumber || null,
    totalByCurrency: order.totalByCurrency || {},
    items: order.items || [],
  });
  const group = duplicateOrderGroups.get(signature) || [];
  group.push(order);
  duplicateOrderGroups.set(signature, group);
}
const exactDuplicateOrders = Array.from(duplicateOrderGroups.values()).filter(group => group.length > 1)
  .map(group => ({
    appointmentId: group[0].appointmentId || null,
    appointmentDate: appointmentsById.get(String(group[0].appointmentId || ''))?.date || null,
    customer: group[0].customerName || 'Walk-in Customer',
    paymentMethod: group[0].paymentMethod || null,
    totalByCurrency: group[0].totalByCurrency || {},
    orderIds: group.map(order => String(order.id)),
    orderTimes: group.map(order => new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false })),
    staffEarnings: lines.filter(line => group.some(order => String(order.id) === line.orderId)),
    orderDetails: group.map(order => ({
      id: String(order.id),
      createdAt: new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }),
      customerId: order.customerId || null,
      paymentMethod: order.paymentMethod || null,
      receipt: order.mpesaReceiptNumber || null,
      totalByCurrency: order.totalByCurrency || {},
      items: (order.items || []).map((item: any) => ({
        type: item.type,
        name: item.name,
        qty: item.qty || 1,
        price: item.price || 0,
        staffName: item.staffName || null,
        staffId: item.staffId || null,
        helperStaffName: item.helperStaffName || null,
        helperStaffId: item.helperStaffId || null,
        commission: item.commission || 0,
        assistantPayment: item.assistantPayment ?? item.helperDeduction ?? 0,
        consumedProducts: (item.consumedProducts || []).map((used: any) => ({ productId: used.productId, name: used.name, qty: used.qty })),
      })),
      earnings: lines.filter(line => line.orderId === String(order.id)).map(line => ({
        staffName: line.staffName,
        staffId: line.staffId,
        role: line.role,
        service: line.service,
        amount: line.amount,
        currency: line.currency,
      })),
    })),
  }));
const dashboardOrders = orders.filter(order => !order.deletedAt && Number(order.createdAt || 0) >= from && Number(order.createdAt || 0) < now + 1);
const dashboardOrderGroups = new Map<string, any[]>();
for (const order of dashboardOrders) {
  if (!order.appointmentId) continue;
  const appointment = appointmentsById.get(String(order.appointmentId));
  const signature = stableStringify({
    appointmentId: order.appointmentId,
    customerId: order.customerId || null,
    customerName: normalize(order.customerName),
    branchId: order.branchId || appointment?.branchId || null,
    paymentMethod: order.paymentMethod || null,
    mpesaReceiptNumber: order.mpesaReceiptNumber || null,
    totalByCurrency: order.totalByCurrency || {},
    items: order.items || [],
  });
  const group = dashboardOrderGroups.get(signature) || [];
  group.push(order);
  dashboardOrderGroups.set(signature, group);
}
const exactDashboardDuplicateOrders = Array.from(dashboardOrderGroups.values()).filter(group => group.length > 1)
  .map(group => ({
    appointmentId: String(group[0].appointmentId),
    appointmentDate: appointmentsById.get(String(group[0].appointmentId))?.date || null,
    orderIds: group.map(order => String(order.id)),
    orderTimes: group.map(order => new Date(Number(order.createdAt || 0)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false })),
    earningsByOrder: group.map(order => ({
      orderId: String(order.id),
      earnings: dashboardLines.filter(line => line.orderId === String(order.id)).map(line => ({ staffName: staffById.get(line.staffId)?.name || 'Unknown', role: line.role, amount: line.amount })),
    })),
  }));
const duplicateOrderIds = Array.from(new Set([
  ...exactDuplicateOrders.flatMap(group => group.orderIds),
  ...exactDashboardDuplicateOrders.flatMap(group => group.orderIds),
]));
const duplicateAuditRows = duplicateOrderIds.length ? await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'audit_logs'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'collection' = 'order'
    AND record->>'recordId' = ANY(${duplicateOrderIds})
` as any[] : [];
const duplicateAuditsByOrderId = new Map<string, any[]>();
for (const row of duplicateAuditRows) {
  const recordId = String(row.record?.recordId || '');
  const events = duplicateAuditsByOrderId.get(recordId) || [];
  events.push(row.record);
  duplicateAuditsByOrderId.set(recordId, events);
}
const receiptGroups = new Map<string, any[]>();
for (const order of ordersInPeriod) {
  const receipt = String(order.mpesaReceiptNumber || '').trim().toUpperCase();
  if (!receipt) continue;
  const group = receiptGroups.get(receipt) || [];
  group.push(order);
  receiptGroups.set(receipt, group);
}
const repeatedReceipts = Array.from(receiptGroups.entries()).filter(([, group]) => group.length > 1)
  .map(([receipt, group]) => ({
    receipt,
    orderIds: group.map(order => String(order.id)),
    customers: group.map(order => order.customerName || 'Walk-in Customer'),
    totals: group.map(order => order.totalByCurrency || {}),
  }));

const summarizeTotal = (sourceLines: { amount: number; currency: string }[]) => Object.fromEntries(
  Array.from(new Set(sourceLines.map(line => line.currency))).sort()
    .map(currency => [currency, sum(sourceLines.filter(line => line.currency === currency))]),
);
console.log(JSON.stringify({
  readOnly: true,
  salon: 'BRAIDYS',
  period: { from: '2026-11-01 00:00:00', through: '2026-11-06 23:59:59.999', timezone: 'Africa/Nairobi' },
  totals: {
    gross: summarizeTotal(grossLines),
    paid: summarizeTotal(paidLines),
    unpaid: summarizeTotal(unpaidLines),
    dashboardThroughNowRawKES: sum(dashboardLines),
    dashboardThroughNowTodayKES: sum(dashboardLines.filter(line => line.createdAt >= todayStart)),
    dashboardPerStaffRoundedKES: Math.round(Array.from(dashboardByStaff.values()).reduce((total, item) => total + Math.round((item.commission + item.assistant) * 100) / 100, 0) * 100) / 100,
    dashboardCompletedWorkLines: dashboardLines.length,
    dashboardCompletedWorkLinesShown: dashboardLines.length,
    dashboardCompletedWorkLinesOmittedBy30RowLimit: 0,
    grossLines: grossLines.length,
    paidLines: paidLines.length,
    unpaidLines: unpaidLines.length,
    grossEqualsPaidPlusUnpaid: Math.round(sum(grossLines) * 100) === Math.round((sum(paidLines) + sum(unpaidLines)) * 100),
  },
  staff: Array.from(summaries.values())
    .sort((left, right) => left.name.localeCompare(right.name) || left.staffId.localeCompare(right.staffId))
    .map(({ staffId, name, grossByCurrency, paidByCurrency, unpaidByCurrency, commissionByCurrency, assistantByCurrency, lineCount }) => {
      const dashboard = dashboardByStaff.get(staffId) || { commission: 0, assistant: 0, today: 0, lineCount: 0 };
      return {
      staffId, name,
      grossKES: grossByCurrency.KES || 0,
      paidKES: paidByCurrency.KES || 0,
      unpaidKES: unpaidByCurrency.KES || 0,
      commissionKES: commissionByCurrency.KES || 0,
      assistantKES: assistantByCurrency.KES || 0,
      lines: lineCount,
      dashboardRawKES: dashboard.commission + dashboard.assistant,
      dashboardRoundedKES: Math.round((dashboard.commission + dashboard.assistant) * 100) / 100,
      dashboardTodayKES: dashboard.today,
      dashboardWorkLines: dashboard.lineCount,
      dashboardWorkLinesOmitted: 0,
      };
    }),
  appointmentReconciliation: {
    completedAppointments: completedAppointments.length,
    completedAppointmentsWithoutActiveOrders: completedAppointmentsWithoutOrders.length,
    completedAppointmentsWithoutActiveOrdersSample: completedAppointmentsWithoutOrders.slice(0, 15),
    completedAppointmentsWithoutEarningsInWindow: completedAppointmentsWithoutWindowEarnings.length,
    completedAppointmentsWithoutEarningsInWindowSample: completedAppointmentsWithoutWindowEarnings.slice(0, 10),
    completedAppointmentsWithoutWindowEarningsIncludedInLiveDashboard: completedAppointmentsCoveredByDashboardToday.length,
    completedAppointmentsWithoutWindowEarningsIncludedInLiveDashboardSample: completedAppointmentsCoveredByDashboardToday.slice(0, 10),
    completedAppointmentsWithMultipleOrders: completedAppointmentsWithMultipleOrders.length,
    completedAppointmentsWithMultipleOrdersSample: completedAppointmentsWithMultipleOrders.slice(0, 10),
    activeOrdersCreatedInWindow: ordersInPeriod.length,
    ordersWithMissingOrDeletedAppointment: windowOrdersWithMissingAppointment.length,
    ordersWithMissingOrDeletedAppointmentSample: windowOrdersWithMissingAppointment.slice(0, 10),
    earningLinesWithNoLiveAppointment: earningLinesWithNoLiveAppointment.length,
    earningLinesWithNoLiveAppointmentSample: earningLinesWithNoLiveAppointment.slice(0, 10),
    serviceItemEarningMismatches: serviceItemMismatches.length,
    serviceItemEarningMismatchSample: serviceItemMismatches.slice(0, 10),
    unexpectedEarningLines: unexpectedEarningLines.length,
    relatedAuditTrail: reconciliationAuditRows.map(row => ({
      recordId: row.record_id,
      collection: row.record_collection,
      action: row.action || null,
      actor: row.actor || null,
      createdAt: row.event_created_at ? new Date(Number(row.event_created_at)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }) : null,
      summary: row.summary || null,
      snapshotDeletedAt: row.snapshot_deleted_at || null,
      snapshotStatus: row.snapshot_status || null,
    })),
  },
  duplicateChecks: {
    exactDuplicateOrderGroupCount: exactDuplicateOrders.length,
    exactDuplicateOrderGroups: exactDuplicateOrders.slice(0, 10).map(group => ({
      appointmentId: group.appointmentId,
      appointmentDate: group.appointmentDate,
      customer: group.customer,
      orderCount: group.orderIds.length,
      orderIds: group.orderIds.slice(0, 6),
      orderTimes: group.orderTimes.slice(0, 3),
      orderDetails: group.orderDetails.map(order => ({
        ...order,
        auditEvents: (duplicateAuditsByOrderId.get(order.id) || []).map(event => ({
          action: event.action || null,
          actor: event.actor || null,
          createdAt: event.createdAt ? new Date(Number(event.createdAt)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }) : null,
        })),
      })),
    })),
    dashboardPeriodExactDuplicateOrderGroupCount: exactDashboardDuplicateOrders.length,
    dashboardPeriodExactDuplicateOrderGroups: exactDashboardDuplicateOrders.map(group => ({
      appointmentId: group.appointmentId,
      appointmentDate: group.appointmentDate,
      orderIds: group.orderIds,
      orderTimes: group.orderTimes,
      earningsByOrder: group.earningsByOrder,
      auditEvents: group.orderIds.flatMap(id => (duplicateAuditsByOrderId.get(id) || []).map(event => ({
        orderId: id,
        action: event.action || null,
        actor: event.actor || null,
        createdAt: event.createdAt ? new Date(Number(event.createdAt)).toLocaleString('en-CA', { timeZone: 'Africa/Nairobi', hour12: false }) : null,
      }))),
    })),
    duplicateActivePayoutMarkerCount: duplicatePayoutMarkers.length,
    duplicateActivePayoutMarkers: duplicatePayoutMarkers.slice(0, 5).map(item => ({ itemKey: item.itemKey, count: item.payoutIds.length })),
    repeatedMpesaReceiptCount: repeatedReceipts.length,
    repeatedMpesaReceipts: repeatedReceipts.slice(0, 5).map(item => ({ receipt: item.receipt, orderIds: item.orderIds.slice(0, 6) })),
    payoutMismatchCount: payoutMismatches.length,
    payoutAmountOrStaffMismatches: payoutMismatches.slice(0, 5).map(({ staffName, staffId, orderId, itemKey, amount, payoutAmounts }) => ({ staffName, staffId, orderId, itemKey, amount, payoutAmounts })),
  },
}, null, 2));