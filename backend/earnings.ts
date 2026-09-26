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

export function staffCommission(item: any, staffId: unknown): number {
  if (!staffId) return 0;
  const hasMultipleStaff = Boolean(item.coStaffId || item.thirdStaffId || item.helperStaffId);
  if (String(item.staffId || '') === String(staffId)) return hasMultipleStaff ? Number(item.primaryCommission ?? serviceCommission(item)) || 0 : serviceCommission(item);
  if (String(item.coStaffId || '') === String(staffId)) return Number(item.coStaffCommission ?? serviceCommission(item)) || 0;
  if (String(item.thirdStaffId || '') === String(staffId)) return Number(item.thirdStaffCommission ?? 0) || 0;
  return 0;
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

export function calculateUnpaidStaffEarnings(
  orders: any[],
  payoutItems: any[],
  appointments: any[],
  from: number,
  to: number,
): StaffEarningLine[] {
  const paidKeys = new Set(payoutItems.filter(item => !item.deletedAt).map(item => String(item.itemKey || '')));
  const appointmentsById = new Map(appointments.filter(appointment => !appointment.deletedAt).map(appointment => [String(appointment.id), appointment]));
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
    if (order.deletedAt || createdAt < from || createdAt >= to) continue;
    for (const [index, item] of (Array.isArray(order.items) ? order.items : []).entries()) {
      if (item.type !== 'service') continue;
      const itemKey = `${order.id}:${index}`;
      const appointment = appointmentsById.get(String(order.appointmentId || '')) as any;
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
