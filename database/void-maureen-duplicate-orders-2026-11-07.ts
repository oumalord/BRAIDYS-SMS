import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { calculateUnpaidStaffEarnings, currentSundayThroughNowRange } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const maureenId = 'ccf4113a-ed05-4621-9dd8-9194bb14289b';
const canonicalOrderId = 'bb9fd237-883c-4fd9-b073-56bd2c372a78';
const duplicateOrderIds = [
  '9b83fe11-255e-4f8f-b9a0-9fa31a12a492',
  '6617ef60-468f-4034-92d0-b3a358aebeb7',
];
const appointmentId = '24afd4b3-8e5e-4e69-be30-07d9ee8b532a';
const reason = 'Duplicate KES 4,000 cash order for the same completed appointment; owner confirmed correction to Maureen assistant earnings.';
const [staffRow] = await sql`SELECT id, tenant_id, record FROM app_records WHERE collection = 'staff' AND id = ${maureenId}` as any[];
const staff = staffRow ? {
  ...staffRow.record,
  id: String(staffRow.id),
  tenantId: staffRow.record?.tenantId || staffRow.tenant_id,
} : null;
if (!staff || String(staff.name || '').trim().toLowerCase() !== 'maureen' || staff.deletedAt) throw new Error('Maureen staff record did not match');

const loadRows = async (collection: string) => await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = ${collection}
    AND (tenant_id = ${staff.tenantId} OR record->>'tenantId' = ${staff.tenantId})
` as any[];
const [appointmentRows, orderRows, payoutRows, productRows] = await Promise.all([
  loadRows('appointments'), loadRows('orders'), loadRows('payout_items'), loadRows('products'),
]);
const records = (rows: any[]) => rows.map(row => ({
  ...row.record,
  id: String(row.id),
  tenantId: row.record?.tenantId || row.tenant_id,
}));

const inScope = (item: any) => item.tenantId === staff.tenantId
  && (!staff.branchId || !item.branchId || item.branchId === staff.branchId);
const appointments = records(appointmentRows).filter(inScope);
const orders = records(orderRows).filter(inScope);
const payoutItems = records(payoutRows).filter(inScope);
const products = records(productRows).filter(inScope);
const targetOrders = duplicateOrderIds.map(id => orders.find(order => String(order.id) === id));
const canonical = orders.find(order => String(order.id) === canonicalOrderId);
const appointment = appointments.find(item => String(item.id) === appointmentId);
if (targetOrders.some(order => !order || order.deletedAt) || !canonical || canonical.deletedAt) throw new Error('Expected active duplicate and canonical orders were not found');
if (!appointment || appointment.date !== '2026-11-01' || appointment.time !== '16:34' || appointment.status !== 'completed' || appointment.deletedAt) {
  throw new Error('The linked Nov 1 completed appointment did not match');
}

const stableStringify = (value: any): string => Array.isArray(value)
  ? `[${value.map(stableStringify).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
    : JSON.stringify(value);
for (const order of [canonical, ...targetOrders as any[]]) {
  if (order.appointmentId !== appointmentId
    || order.customerName !== 'Walk-in Customer'
    || order.paymentMethod !== 'Cash'
    || Number(order.totalByCurrency?.KES) !== 4000
    || stableStringify(order.items) !== stableStringify(canonical.items)) {
    throw new Error(`Order ${order.id} does not match the confirmed duplicate sale`);
  }
  const service = order.items?.[0];
  if (service?.type !== 'service' || String(service.name || '').toLowerCase() !== 'knotless'
    || String(service.helperStaffId || '') !== maureenId
    || Number(service.assistantPayment ?? service.helperDeduction) !== 500) {
    throw new Error(`Order ${order.id} does not contain Maureen's expected KES 500 assistant line`);
  }
}
const payoutReferences = payoutItems.filter(item => duplicateOrderIds.includes(String(item.orderId || ''))
  || duplicateOrderIds.some(id => String(item.itemKey || '').startsWith(`${id}:`)));
if (payoutReferences.length) throw new Error('A duplicate order has payout history; refusing to void it');

const period = currentSundayThroughNowRange();
const now = Date.now();
const currentLines = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, period.from, now + 1)
  .filter(line => line.staffId === maureenId && line.currency === 'KES');
const currentTotal = currentLines.reduce((sum, line) => sum + line.amount, 0);
const duplicateEarnings = currentLines.filter(line => duplicateOrderIds.includes(line.orderId))
  .reduce((sum, line) => sum + line.amount, 0);
const projectedTotal = currentLines.filter(line => !duplicateOrderIds.includes(line.orderId))
  .reduce((sum, line) => sum + line.amount, 0);
if (currentTotal !== 2200 || duplicateEarnings !== 1000 || projectedTotal !== 1200) {
  throw new Error(`Refusing correction: current=${currentTotal}, duplicate=${duplicateEarnings}, projected=${projectedTotal}; expected 2200/1000/1200 KES`);
}

const restoreQuantities = new Map<string, number>();
for (const order of targetOrders as any[]) {
  for (const item of order.items || []) {
    if (item.type === 'product' && item.refId) restoreQuantities.set(String(item.refId), (restoreQuantities.get(String(item.refId)) || 0) + Number(item.qty || 0));
    for (const used of item.consumedProducts || []) {
      if (used.productId) restoreQuantities.set(String(used.productId), (restoreQuantities.get(String(used.productId)) || 0) + Number(used.qty || 0));
    }
  }
}
const productUpdates = Array.from(restoreQuantities.entries()).map(([id, quantity]) => {
  const product = products.find(item => String(item.id) === id);
  if (!product) throw new Error(`Cannot restore missing product ${id}`);
  return { id, quantity, record: { ...product, stock: Number(product.stock || 0) + quantity } };
});

const customerIds = new Set((targetOrders as any[]).map(order => String(order.customerId || '')).filter(Boolean));
const customerRows = customerIds.size ? await sql`
  SELECT id, tenant_id, record FROM app_records
  WHERE collection = 'customers'
    AND id = ANY(${Array.from(customerIds)})
    AND (tenant_id = ${staff.tenantId} OR record->>'tenantId' = ${staff.tenantId})
` as any[] : [];
const activeOrdersAfter = orders.filter(order => !order.deletedAt && !duplicateOrderIds.includes(String(order.id)));
const customerUpdates = records(customerRows).filter(inScope).map(customer => {
  const customerOrders = activeOrdersAfter.filter(order => String(order.customerId || '') === String(customer.id));
  return {
    id: String(customer.id),
    record: {
      ...customer,
      totalSpent: customerOrders.reduce((sum, order) => sum + Number(order.totalByCurrency?.KES || 0), 0),
      totalSpentUSD: customerOrders.reduce((sum, order) => sum + Number(order.totalByCurrency?.USD || 0), 0),
      visits: customerOrders.length,
      loyaltyPoints: Math.max(0, customerOrders.reduce((sum, order) => sum + Math.floor(Number(order.totalByCurrency?.KES || 0) / 100) - Number(order.pointsRedeemed || 0), 0)),
      lastVisit: customerOrders.reduce((latest, order) => Math.max(latest, Number(order.createdAt || 0)), 0) || null,
    },
  };
});

const confirmation = process.argv.includes('--confirm');
if (!confirmation) {
  console.log(JSON.stringify({
    dryRun: true,
    branchId: staff.branchId,
    appointment: { id: appointmentId, date: appointment.date, time: appointment.time },
    currentUnpaidKES: currentTotal,
    duplicateAssistantEarningsKES: duplicateEarnings,
    projectedUnpaidKES: projectedTotal,
    voidOrderIds: duplicateOrderIds,
    payoutReferences: payoutReferences.length,
    stockToRestore: productUpdates.map(item => ({ productId: item.id, quantity: item.quantity })),
    customersToRecalculate: customerUpdates.map(item => item.id),
    action: 'No records changed. Pass --confirm to void the two duplicate orders.',
  }, null, 2));
} else {
  const deletedAt = Date.now();
  const voidedRows = await sql`
    UPDATE app_records
    SET record = record || jsonb_build_object(
      'deletedAt', ${deletedAt}::bigint,
      'deletedBy', 'owner',
      'voidReason', ${reason}::text
    )
    WHERE collection = 'orders'
      AND id = ANY(${duplicateOrderIds})
      AND NOT (record ? 'deletedAt')
      AND (
        SELECT COUNT(*) FROM app_records
        WHERE collection = 'orders' AND id = ANY(${duplicateOrderIds}) AND NOT (record ? 'deletedAt')
      ) = ${duplicateOrderIds.length}
    RETURNING id
  ` as { id: string }[];
  if (voidedRows.length !== duplicateOrderIds.length) throw new Error(`Expected to void ${duplicateOrderIds.length} orders, voided ${voidedRows.length}`);

  for (const update of productUpdates) {
    await sql`UPDATE app_records SET record = ${JSON.stringify(update.record)}::jsonb WHERE collection = 'products' AND id = ${update.id}`;
    await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (
      ${randomUUID()}, 'stock_movements', ${staff.tenantId}, ${JSON.stringify({
        tenantId: staff.tenantId,
        branchId: staff.branchId,
        productId: update.id,
        productName: update.record.name,
        change: update.quantity,
        reason: `Voided duplicate order(s): ${duplicateOrderIds.join(', ')}`,
        createdAt: deletedAt,
        actor: 'owner',
      })}::jsonb
    )`;
  }
  for (const update of customerUpdates) {
    await sql`UPDATE app_records SET record = ${JSON.stringify(update.record)}::jsonb WHERE collection = 'customers' AND id = ${update.id}`;
  }
  for (const order of targetOrders as any[]) {
    const auditId = randomUUID();
    const auditRecord = {
      id: auditId,
      tenantId: staff.tenantId,
      branchId: staff.branchId,
      action: 'voided duplicate order',
      collection: 'order',
      actor: 'owner',
      recordId: String(order.id),
      summary: `voided duplicate order: ${order.customerName}`,
      recordSnapshot: order,
      reason,
      createdAt: deletedAt,
    };
    await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (
      ${auditId}, 'audit_logs', ${staff.tenantId}, ${JSON.stringify(auditRecord)}::jsonb
    )`;
  }

  const updatedRows = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${duplicateOrderIds})` as any[];
  const verifiedVoids = updatedRows.filter(row => row.record?.deletedAt && row.record?.voidReason === reason).length;
  const remainingTotal = calculateUnpaidStaffEarnings(
    orders.map(order => duplicateOrderIds.includes(String(order.id)) ? { ...order, deletedAt } : order),
    payoutItems,
    appointments,
    period.from,
    Date.now() + 1,
  ).filter(line => line.staffId === maureenId && line.currency === 'KES')
    .reduce((sum, line) => sum + line.amount, 0);
  if (verifiedVoids !== duplicateOrderIds.length || remainingTotal !== 1200) {
    throw new Error(`Post-correction verification failed: voided=${verifiedVoids}, remaining=${remainingTotal} KES`);
  }
  console.log(JSON.stringify({
    corrected: true,
    voidedOrderIds: duplicateOrderIds,
    restoredInventory: productUpdates.map(item => ({ productId: item.id, quantity: item.quantity })),
    recalculatedCustomers: customerUpdates.map(item => item.id),
    unpaidEarningsKES: remainingTotal,
    reason,
  }, null, 2));
}