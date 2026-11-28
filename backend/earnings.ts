export function serviceCommission(item: any): number {
  if (item?.type !== 'service') return 0;
  const recorded = Number(item.commission);
  if (Number.isFinite(recorded)) return Math.max(0, recorded);
  const revenue = Number(item.lineTotalAfterDiscount ?? Number(item.price || 0) * Number(item.qty || 1)) || 0;
  const productCost = Math.max(0, Number(item.productCost || 0));
  const assistantFee = Math.max(0, Number(item.assistantPayment ?? item.helperDeduction ?? 0));
  const commissionBase = Math.max(0, Number(item.commissionBase ?? (revenue - productCost - assistantFee)) || 0);
  const rate = Number(item.commissionPct ?? item.commissionRate ?? 50);
  return commissionBase * (Number.isFinite(rate) ? rate / 100 : 0.5);
}

function serviceCommissionAtRate(item: any): number {
  if (item?.type !== 'service') return 0;
  const revenue = Number(item.lineTotalAfterDiscount ?? Number(item.price || 0) * Number(item.qty || 1)) || 0;
  const productCost = Math.max(0, Number(item.productCost || 0));
  const assistantFee = Math.max(0, Number(item.assistantPayment ?? item.helperDeduction ?? 0));
  const commissionBase = Math.max(0, Number(item.commissionBase ?? revenue - productCost - assistantFee) || 0);
  const rate = Number(item.commissionPct ?? item.commissionRate ?? 50);
  return commissionBase * (Number.isFinite(rate) ? rate / 100 : 0.5);
}

export function staffCommission(item: any, staffId: unknown): number {
  if (!staffId) return 0;
  const hasMultipleStaff = Boolean(item.coStaffId || item.thirdStaffId || item.helperStaffId);
  if (String(item.staffId || '') === String(staffId)) return hasMultipleStaff ? Number(item.primaryCommission ?? item.commission ?? serviceCommissionAtRate(item)) || 0 : serviceCommission(item);
  if (String(item.coStaffId || '') === String(staffId)) return Number(item.coStaffCommission ?? serviceCommissionAtRate(item)) || 0;
  if (String(item.thirdStaffId || '') === String(staffId)) return Number(item.thirdStaffCommission ?? serviceCommissionAtRate(item)) || 0;
  return 0;
}

export function staffAppointmentMinutes(appointment: any, staffId: unknown): number {
  const items = Array.isArray(appointment?.items) ? appointment.items : [];
  const assigned = items.filter((item: any) => String(item.staffId || '') === String(staffId || ''));
  if (assigned.length) return assigned.reduce((sum: number, item: any) => sum + Math.max(0, Number(item.durationMin || 0)), 0);
  const hasItemAssignments = items.some((item: any) => item.staffId);
  return !hasItemAssignments && String(appointment?.staffId || '') === String(staffId || '')
    ? Math.max(0, Number(appointment?.durationMin || 0))
    : 0;
}

export interface StaffEarningLine {
  itemKey: string;
  orderId: string;
  staffId: string;
  serviceName: string;
  role: 'commission' | 'assistant';
  amount: number;
  currency: string;
  revenue: number;
  commissionBase: number;
  helperDeduction: number;
  productCost: number;
  createdAt: number;
  branchId: string | null;
}

export function confirmedPaystackItemKeys(payrollItems: any[]) {
  return new Set(payrollItems
    .filter(item => item.provider === 'paystack' && item.status === 'success')
    .flatMap(item => {
      const itemKeys = Array.isArray(item.itemKeys) ? item.itemKeys : [];
      const earningKeys = Array.isArray(item.earningLines) ? item.earningLines.map((line: any) => line?.itemKey) : [];
      return [...itemKeys, ...earningKeys].map(String).filter(Boolean);
    }));
}

export function completedAppointmentStaffEarnings(
  appointments: any[],
  orders: any[],
  staffId: string,
  from: number,
  to: number,
  payoutItems: any[] = [],
  payrollItems: any[] = [],
): StaffEarningLine[] {
  const orderedAppointments = new Set(orders.filter(order => !order.deletedAt && order.appointmentId).map(order => String(order.appointmentId)));
  const activePayoutItems = payrollItems.length
    ? paystackConfirmedPayoutItems(payoutItems, payrollItems)
    : payoutItems.filter(item => !item.deletedAt);
  const paidKeys = new Set([
    ...activePayoutItems.map(item => String(item.itemKey || '')).filter(Boolean),
    ...confirmedPaystackItemKeys(payrollItems),
  ]);
  const lines: StaffEarningLine[] = [];
  for (const appointment of appointments) {
    const appointmentId = String(appointment.id || '');
    if (!appointmentId || appointment.deletedAt || String(appointment.status || '').toLowerCase() !== 'completed' || orderedAppointments.has(appointmentId)) continue;
    const date = String(appointment.date || '');
    const appointmentDateStart = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? Date.parse(`${date}T00:00:00+03:00`)
      : Number.NaN;
    const completedAt = Number(appointment.completedAt || appointment.updatedAt) || Number(appointment.createdAt || 0);
    const earningDate = Number.isFinite(appointmentDateStart) ? appointmentDateStart : completedAt;
    if (earningDate < from || earningDate >= to) continue;
    const serviceItems = Array.isArray(appointment.items) && appointment.items.length
      ? appointment.items
      : [{ name: appointment.serviceName, price: appointment.price, currency: appointment.currency, staffId: appointment.staffId }];
    for (const [index, item] of serviceItems.entries()) {
      if (item.type && item.type !== 'service') continue;
      const earningItem = { ...item, type: 'service', staffId: item.staffId || appointment.staffId };
      const serviceStaffIds = [earningItem.staffId, item.coStaffId, item.thirdStaffId, item.helperStaffId].map(value => String(value || ''));
      if (!serviceStaffIds.includes(staffId)) continue;
      const revenue = Number(item.lineTotalAfterDiscount ?? Number(item.price ?? appointment.price ?? 0) * Number(item.qty || 1)) || 0;
      const productCost = Math.max(0, Number(item.productCost || 0));
      const helperDeduction = Math.max(0, Number(item.assistantPayment ?? item.helperDeduction ?? 0));
      const commissionBase = Math.max(0, Number(item.commissionBase ?? revenue - productCost - helperDeduction) || 0);
      const role = String(item.helperStaffId || '') === staffId ? 'assistant' : 'commission';
      const amount = role === 'assistant' ? helperDeduction : staffCommission(earningItem, staffId);
      const itemKey = `appointment:${appointmentId}:${index}:${role}`;
      if (amount <= 0 || paidKeys.has(itemKey)) continue;
      lines.push({
        itemKey,
        orderId: `appointment:${appointmentId}`,
        staffId,
        serviceName: String(item.name || item.serviceName || appointment.serviceName || 'Service'),
        role,
        amount,
        currency: String(item.currency || appointment.currency || 'KES'),
        revenue,
        commissionBase,
        helperDeduction,
        productCost,
        createdAt: completedAt,
        branchId: appointment.branchId || null,
      });
    }
  }
  return lines;
}

export function paystackConfirmedPayoutItems(payoutItems: any[], payrollItems: any[]) {
  const confirmedKeys = confirmedPaystackItemKeys(payrollItems);
  return payoutItems.filter(item => !item.deletedAt && confirmedKeys.has(String(item.itemKey || '')));
}

export function currentSundayThroughNowRange(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find(value => value.type === type)?.value);
  const today = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  const currentSunday = new Date(today);
  currentSunday.setUTCDate(today.getUTCDate() - today.getUTCDay());
  const from = Date.UTC(currentSunday.getUTCFullYear(), currentSunday.getUTCMonth(), currentSunday.getUTCDate()) - 3 * 60 * 60 * 1000;
  return { from, to: date.getTime() + 1 };
}

export function previousSaturdayThroughYesterdayRange(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find(value => value.type === type)?.value);
  const today = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  const currentSunday = new Date(today);
  currentSunday.setUTCDate(today.getUTCDate() - today.getUTCDay());
  const previousSaturday = new Date(currentSunday);
  previousSaturday.setUTCDate(currentSunday.getUTCDate() - 1);
  const nairobiMidnight = (day: Date) => Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - 3 * 60 * 60 * 1000;
  return { from: nairobiMidnight(previousSaturday), to: nairobiMidnight(today) };
}

export function mostRecentSaturdayThroughFridayRange(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find(value => value.type === type)?.value);
  const today = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  const latestSaturday = new Date(today);
  const daysSinceSaturday = (today.getUTCDay() + 1) % 7;
  latestSaturday.setUTCDate(today.getUTCDate() - daysSinceSaturday);
  const previousSaturday = new Date(latestSaturday);
  previousSaturday.setUTCDate(latestSaturday.getUTCDate() - 7);
  const nairobiMidnight = (day: Date) => Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - 3 * 60 * 60 * 1000;
  return { from: nairobiMidnight(previousSaturday), to: nairobiMidnight(latestSaturday) };
}

export function currentSaturdayThroughFridayRange(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find(value => value.type === type)?.value);
  const today = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  const currentSaturday = new Date(today);
  const daysSinceSaturday = (today.getUTCDay() + 1) % 7;
  currentSaturday.setUTCDate(today.getUTCDate() - daysSinceSaturday);
  if (today.getUTCDay() === 6 && part('hour') < 17) currentSaturday.setUTCDate(currentSaturday.getUTCDate() - 7);
  const from = Date.UTC(currentSaturday.getUTCFullYear(), currentSaturday.getUTCMonth(), currentSaturday.getUTCDate()) - 3 * 60 * 60 * 1000 + 17 * 60 * 60 * 1000;
  return { from, to: from + 7 * 24 * 60 * 60 * 1000 };
}

export function calculateUnpaidStaffEarnings(
  orders: any[],
  payoutItems: any[],
  appointments: any[],
  from: number,
  to: number,
  payrollItems: any[] = [],
): StaffEarningLine[] {
  const activePayoutItems = payrollItems.length
    ? paystackConfirmedPayoutItems(payoutItems, payrollItems)
    : payoutItems.filter(item => !item.deletedAt);
  const activePayoutKeys = new Set(activePayoutItems.map(item => String(item.itemKey || '')).filter(Boolean));
  const paidKeys = new Set([...activePayoutKeys, ...confirmedPaystackItemKeys(payrollItems)]);
  const appointmentsById = new Map(appointments.map(appointment => [String(appointment.id), appointment]));
  const lines: StaffEarningLine[] = [];
  const addLine = (order: any, item: any, itemKey: string, staffId: unknown, role: 'commission' | 'assistant', amount: number, revenue: number, commissionBase: number, helperDeduction: number, productCost: number) => {
    if (!staffId || paidKeys.has(itemKey)) return;
    lines.push({
      itemKey,
      orderId: String(order.id),
      staffId: String(staffId),
      serviceName: String(item.name || 'Service'),
      role,
      amount: Math.max(0, Number(amount) || 0),
      currency: String(item.currency || 'KES'),
      revenue,
      commissionBase,
      helperDeduction,
      productCost,
      createdAt: Number(order.createdAt),
      branchId: order.branchId || null,
    });
  };

  for (const order of orders) {
    const createdAt = Number(order.createdAt || 0);
    const appointment = appointmentsById.get(String(order.appointmentId || '')) as any;
    if (appointment && (appointment.deletedAt || ['cancelled', 'no-show'].includes(String(appointment.status || '').toLowerCase()))) continue;
    const appointmentDate = String(appointment?.date || '');
    const appointmentDateStart = /^\d{4}-\d{2}-\d{2}$/.test(appointmentDate)
      ? Date.parse(`${appointmentDate}T00:00:00+03:00`)
      : Number.NaN;
    const earningDate = Number.isFinite(appointmentDateStart) ? appointmentDateStart : createdAt;
    if (order.deletedAt || earningDate < from || earningDate >= to) continue;
    for (const [index, item] of (Array.isArray(order.items) ? order.items : []).entries()) {
      if (item.type !== 'service') continue;
      const itemKey = `${order.id}:${index}`;
      const primaryStaffId = item.staffId || appointment?.staffId;
      const commissionItem = primaryStaffId === item.staffId
        ? item
        : { ...item, staffId: primaryStaffId, staffName: item.staffName || appointment?.staffName };
      const revenue = Number(item.lineTotalAfterDiscount ?? Number(item.price || 0) * Number(item.qty || 1)) || 0;
      const productCost = Math.max(0, Number(item.productCost || 0));
      const helperDeduction = Math.max(0, Number(item.assistantPayment ?? item.helperDeduction ?? 0));
      const commissionBase = Math.max(0, Number(item.commissionBase ?? revenue - productCost - helperDeduction) || 0);

      addLine(order, item, itemKey, primaryStaffId, 'commission', staffCommission(commissionItem, primaryStaffId), revenue, commissionBase, helperDeduction, productCost);
      addLine(order, item, `${itemKey}:co-staff`, item.coStaffId, 'commission', staffCommission(item, item.coStaffId), revenue, commissionBase, helperDeduction, productCost);
      addLine(order, item, `${itemKey}:third-staff`, item.thirdStaffId, 'commission', staffCommission(item, item.thirdStaffId), revenue, commissionBase, helperDeduction, productCost);
      addLine(order, item, `${itemKey}:assistant`, item.helperStaffId, 'assistant', helperDeduction, 0, 0, 0, 0);
    }
  }
  return lines;
}
