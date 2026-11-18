import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const restoreDayFrom = Date.parse('2026-11-07T00:00:00+03:00');
const restoreDayTo = Date.parse('2026-11-08T00:00:00+03:00');
const historicalSummary = 'soft-deleted appointments before 2026-10-31 and voided linked orders';
const sql = neon(databaseUrl);

const [auditRows, allOrderRows, allAppointmentRows, payoutRows, productRows, queueRows] = await Promise.all([
  sql`SELECT id, tenant_id, record FROM app_records
    WHERE collection = 'audit_logs' AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
      AND (record->>'createdAt')::numeric >= ${restoreDayFrom} AND (record->>'createdAt')::numeric < ${restoreDayTo}
      AND record->>'actor' = 'owner'` as any[],
  sql`SELECT id, tenant_id, record FROM app_records WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})` as any[],
  sql`SELECT id, tenant_id, record FROM app_records WHERE collection = 'appointments'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})` as any[],
  sql`SELECT id, tenant_id, record FROM app_records WHERE collection = 'payout_items'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})` as any[],
  sql`SELECT id, tenant_id, record FROM app_records WHERE collection = 'products'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})` as any[],
  sql`SELECT id, tenant_id, record FROM app_records WHERE collection = 'queue'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})` as any[],
]);

const records = (rows: any[]) => rows.map(row => ({
  ...row.record,
  id: String(row.id),
  tenantId: row.record?.tenantId || row.tenant_id,
}));
const auditRecords = records(auditRows);
const orders = records(allOrderRows);
const appointments = records(allAppointmentRows);
const payoutItems = records(payoutRows);
const products = records(productRows);
const queue = records(queueRows);
const cleanupAudit = auditRecords.find(item => item.summary === historicalSummary);
if (!cleanupAudit) throw new Error('Could not find the Nov 7 historical cleanup audit; refusing to restore unscoped records.');

const historicalAppointmentIds = Array.isArray(cleanupAudit.appointmentIds) ? cleanupAudit.appointmentIds.map(String) : [];
const historicalOrderIds = Array.isArray(cleanupAudit.orderIds) ? cleanupAudit.orderIds.map(String) : [];
const historicalQueueIds = Array.isArray(cleanupAudit.queueIds) ? cleanupAudit.queueIds.map(String) : [];
const deletionAudits = auditRecords.filter(item => ['voided duplicate order', 'voided order linked to deleted appointment'].includes(String(item.action))
  && item.recordSnapshot && item.recordId);
const orderDeleteAuditById = new Map<string, any>();
for (const item of deletionAudits.sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))) {
  orderDeleteAuditById.set(String(item.recordId), item);
}
const deletedAt = Number(cleanupAudit.createdAt);
const deletionReason = 'Owner requested removal of appointments before 2026-10-31 and their locally settled revenues from active finance and payroll.';

const appointmentById = new Map(appointments.map(item => [String(item.id), item]));
const orderById = new Map(orders.map(item => [String(item.id), item]));
const queueById = new Map(queue.map(item => [String(item.id), item]));
if (process.argv.includes('--verify')) {
  const restoreAudit = auditRecords.find(item => item.action === 'restored assistant soft-deleted records');
  if (!restoreAudit) throw new Error('Restore audit entry is missing.');
  const restoredAppointments = historicalAppointmentIds.filter(id => !appointmentById.get(id)?.deletedAt).length;
  const restoredHistoricalOrders = historicalOrderIds.filter(id => !orderById.get(id)?.deletedAt).length;
  const restoredDuplicateOrders = Array.from(orderDeleteAuditById.keys()).filter(id => !historicalOrderIds.includes(id) && !orderById.get(id)?.deletedAt).length;
  const restoredQueueEntries = historicalQueueIds.filter(id => !queueById.get(id)?.deletedAt).length;
  const currentEarnings = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, Date.parse('2026-10-31T00:00:00+03:00'), Date.parse('2026-11-07T00:00:00+03:00'));
  const currentUnpaidKES = currentEarnings.reduce((sum, line) => sum + line.amount, 0);
  const restoredOrderIds = new Set((Array.isArray(restoreAudit.recordIds) ? restoreAudit.recordIds : []).map(String));
  const preRestoreOrders = orders.map(order => restoredOrderIds.has(String(order.id)) ? { ...order, deletedAt: Number(restoreAudit.createdAt) } : order);
  const restoredAppointmentIds = new Set(historicalAppointmentIds.filter(id => !appointmentById.get(id)?.deletedAt));
  const preRestoreAppointments = appointments.map(appointment => restoredAppointmentIds.has(String(appointment.id))
    ? { ...appointment, deletedAt: deletedAt } : appointment);
  const preRestoreEarnings = calculateUnpaidStaffEarnings(preRestoreOrders, payoutItems, preRestoreAppointments,
    Date.parse('2026-10-31T00:00:00+03:00'), Date.parse('2026-11-07T00:00:00+03:00'));
  const preRestoreUnpaidKES = preRestoreEarnings.reduce((sum, line) => sum + line.amount, 0);
  const actualEarningsDeltaKES = currentUnpaidKES - preRestoreUnpaidKES;
  const [triggerRow] = await sql`SELECT pg_get_functiondef('prevent_safigroom_committed_update()'::regprocedure) AS definition` as any[];
  const strictTriggerRestored = /Committed SafiGroom records cannot be edited/.test(String(triggerRow?.definition || ''))
    && !String(triggerRow?.definition || '').includes('braidysms.restore_id');
  if (restoredAppointments !== Number(cleanupAudit.appointmentCount)
    || restoredHistoricalOrders !== Number(cleanupAudit.orderCount)
    || restoredDuplicateOrders !== orderDeleteAuditById.size
    || restoredQueueEntries !== historicalQueueIds.length
    || Math.abs(preRestoreUnpaidKES - Number(restoreAudit.currentUnpaidKES)) > 0.000001
    || !strictTriggerRestored) {
    throw new Error(`Post-restore verification failed: ${JSON.stringify({ restoredAppointments, restoredHistoricalOrders, restoredDuplicateOrders, restoredQueueEntries, preRestoreUnpaidKES, currentUnpaidKES, strictTriggerRestored })}`);
  }
  console.log(JSON.stringify({
    verified: true, restoreAuditId: restoreAudit.id, restoredAppointments, restoredHistoricalOrders,
    restoredDuplicateOrders, restoredQueueEntries, currentUnpaidLines: currentEarnings.length,
    preRestoreUnpaidKES, currentUnpaidKES, actualEarningsDeltaKES,
    dryRunEarningsDeltaKES: restoreAudit.restoredEarningsDeltaKES, strictTriggerRestored,
  }, null, 2));
  process.exit(0);
}
if (process.argv.includes('--record-correction')) {
  const restoreAudit = auditRecords.find(item => item.action === 'restored assistant soft-deleted records');
  if (!restoreAudit) throw new Error('Restore audit entry is missing.');
  const priorCorrection = auditRecords.find(item => item.action === 'corrected restored payroll projection'
    && String(item.restoreAuditId || '') === String(restoreAudit.id));
  if (priorCorrection) {
    console.log(JSON.stringify({ corrected: false, correctionAuditId: priorCorrection.id, message: 'Correction audit already exists.' }, null, 2));
    process.exit(0);
  }
  const currentEarnings = calculateUnpaidStaffEarnings(orders, payoutItems, appointments,
    Date.parse('2026-10-31T00:00:00+03:00'), Date.parse('2026-11-07T00:00:00+03:00'));
  const restoredOrderIds = new Set((Array.isArray(restoreAudit.recordIds) ? restoreAudit.recordIds : []).map(String));
  const preRestoreOrders = orders.map(order => restoredOrderIds.has(String(order.id)) ? { ...order, deletedAt: Number(restoreAudit.createdAt) } : order);
  const restoredAppointmentIds = new Set(historicalAppointmentIds.filter(id => !appointmentById.get(id)?.deletedAt));
  const preRestoreAppointments = appointments.map(appointment => restoredAppointmentIds.has(String(appointment.id))
    ? { ...appointment, deletedAt } : appointment);
  const preRestoreEarnings = calculateUnpaidStaffEarnings(preRestoreOrders, payoutItems, preRestoreAppointments,
    Date.parse('2026-10-31T00:00:00+03:00'), Date.parse('2026-11-07T00:00:00+03:00'));
  const actualEarningsDeltaKES = currentEarnings.reduce((sum, line) => sum + line.amount, 0)
    - preRestoreEarnings.reduce((sum, line) => sum + line.amount, 0);
  if (Math.abs(preRestoreEarnings.reduce((sum, line) => sum + line.amount, 0) - Number(restoreAudit.currentUnpaidKES)) > 0.000001) {
    throw new Error('Current data no longer matches the recorded pre-restore payroll baseline.');
  }
  const correctionId = randomUUID();
  const correction = {
    id: correctionId, tenantId, action: 'corrected restored payroll projection', collection: 'audit_restore',
    actor: 'owner', recordId: restoreAudit.id, restoreAuditId: restoreAudit.id,
    summary: 'Corrected the restore preview delta; 238 appointments were already deleted before the restored cleanup.',
    previousProjectedUnpaidKES: restoreAudit.projectedUnpaidKES,
    previousEarningsDeltaKES: restoreAudit.restoredEarningsDeltaKES,
    preRestoreUnpaidKES: preRestoreEarnings.reduce((sum, line) => sum + line.amount, 0),
    currentUnpaidKES: currentEarnings.reduce((sum, line) => sum + line.amount, 0),
    actualEarningsDeltaKES, createdAt: Date.now(),
  };
  await sql`INSERT INTO app_records (id, collection, tenant_id, record)
    VALUES (${correctionId}, 'audit_logs', ${tenantId}, ${JSON.stringify(correction)}::jsonb)`;
  console.log(JSON.stringify({ corrected: true, correctionAuditId: correctionId, ...correction }, null, 2));
  process.exit(0);
}
const appointmentsToRestore = historicalAppointmentIds.flatMap(id => {
  const appointment = appointmentById.get(id);
  if (!appointment) throw new Error(`Missing audited appointment ${id}; refusing partial restore.`);
  if (!appointment.deletedAt) return [];
  if (Number(appointment.deletedAt) !== deletedAt) return [];
  if (appointment.deletionReason !== deletionReason) {
    throw new Error(`Appointment ${id} no longer matches the cleanup audit; refusing to overwrite newer state.`);
  }
  return [appointment];
});
const historicalOrdersToRestore = historicalOrderIds.flatMap(id => {
  const order = orderById.get(id);
  if (!order) throw new Error(`Missing audited order ${id}; refusing partial restore.`);
  if (!order.deletedAt) return [];
  if (Number(order.deletedAt) !== deletedAt || order.voidReason !== deletionReason) {
    throw new Error(`Order ${id} no longer matches the cleanup audit; refusing to overwrite newer state.`);
  }
  return [order];
});
const duplicateOrdersToRestore = Array.from(orderDeleteAuditById.entries()).flatMap(([id, audit]) => {
  if (historicalOrderIds.includes(id)) return [];
  const order = orderById.get(id);
  if (!order) throw new Error(`Missing audited duplicate order ${id}; refusing partial restore.`);
  if (!order.deletedAt) return [];
  if (Number(order.deletedAt) !== Number(audit.createdAt)) {
    throw new Error(`Order ${id} no longer matches its audit snapshot; refusing to overwrite newer state.`);
  }
  return [{ id, record: audit.recordSnapshot }];
});
const queueToRestore = historicalQueueIds.flatMap(id => {
  const entry = queueById.get(id);
  if (!entry) throw new Error(`Missing audited queue entry ${id}; refusing partial restore.`);
  if (!entry.deletedAt) return [];
  if (Number(entry.deletedAt) !== deletedAt) throw new Error(`Queue entry ${id} no longer matches the cleanup timestamp.`);
  return [entry];
});

if (appointmentsToRestore.length !== Number(cleanupAudit.appointmentCount || 0)
  || historicalOrdersToRestore.length !== Number(cleanupAudit.orderCount || 0)) {
  throw new Error(`Audited restore count changed: appointments ${appointmentsToRestore.length}/${cleanupAudit.appointmentCount}, orders ${historicalOrdersToRestore.length}/${cleanupAudit.orderCount}`);
}

const historicalOrderIdSet = new Set(historicalOrderIds);
const historicalOrders = orders.filter(order => historicalOrderIdSet.has(String(order.id)));
const snapshotOrderRecords = new Map(duplicateOrdersToRestore.map(item => [item.id, item.record]));
const restoreOrderRecords = new Map<string, any>();
for (const order of historicalOrdersToRestore) {
  const restored = { ...order };
  delete restored.deletedAt;
  delete restored.deletedBy;
  delete restored.voidReason;
  delete restored.deletionReason;
  delete restored.payoutReversalRequired;
  restoreOrderRecords.set(String(order.id), restored);
}
for (const [id, record] of snapshotOrderRecords) restoreOrderRecords.set(id, record);

const restoredOrders = orders.map(order => restoreOrderRecords.get(String(order.id)) || order);
const appointmentsBeingRestored = new Set(appointmentsToRestore.map(item => String(item.id)));
const restoredAppointments = appointments.map(appointment => {
  if (!appointmentsBeingRestored.has(String(appointment.id))) return appointment;
  const restored = { ...appointment };
  delete restored.deletedAt;
  delete restored.deletedBy;
  delete restored.deletionReason;
  return restored;
});
const payrollFrom = Date.parse('2026-10-31T00:00:00+03:00');
const payrollTo = Date.parse('2026-11-07T00:00:00+03:00');
const currentEarnings = calculateUnpaidStaffEarnings(orders, payoutItems, appointments, payrollFrom, payrollTo);
const projectedEarnings = calculateUnpaidStaffEarnings(restoredOrders, payoutItems, restoredAppointments, payrollFrom, payrollTo);
const earningDeltaKES = projectedEarnings.reduce((sum, line) => sum + line.amount, 0)
  - currentEarnings.reduce((sum, line) => sum + line.amount, 0);
const revenueDeltaKES = Array.from(restoreOrderRecords.values()).reduce((sum, order) => sum + Number(order.totalByCurrency?.KES || 0), 0);
const revenueDeltaUSD = Array.from(restoreOrderRecords.values()).reduce((sum, order) => sum + Number(order.totalByCurrency?.USD || 0), 0);
const payoutKeys = new Set(payoutItems.filter(item => !item.deletedAt).map(item => String(item.itemKey || '')));
const restoredItemKeys = new Set(Array.from(restoreOrderRecords.values()).flatMap(order => (order.items || []).flatMap((item: any, index: number) => [
  `${order.id}:${index}`, `${order.id}:${index}:co-staff`, `${order.id}:${index}:third-staff`, `${order.id}:${index}:assistant`,
])));
const activePayoutConflicts = Array.from(restoredItemKeys).filter(key => payoutKeys.has(key));
if (activePayoutConflicts.length) throw new Error(`Found ${activePayoutConflicts.length} active payout markers on records being restored; refusing a possible double payment.`);

const productQuantities = new Map<string, number>();
for (const order of restoreOrderRecords.values()) {
  for (const item of order.items || []) {
    if (item.type === 'product' && item.refId) productQuantities.set(String(item.refId), (productQuantities.get(String(item.refId)) || 0) + Number(item.qty || 0));
    for (const used of item.consumedProducts || []) {
      if (used.productId) productQuantities.set(String(used.productId), (productQuantities.get(String(used.productId)) || 0) + Number(used.qty || 0));
    }
  }
}
const productsToAdjust = Array.from(productQuantities.entries()).map(([id, quantity]) => {
  const product = products.find(item => String(item.id) === id);
  if (!product) throw new Error(`Missing product ${id}; refusing to restore orders without inventory reconciliation.`);
  const stock = Number(product.stock || 0) - quantity;
  if (stock < 0) throw new Error(`Restoring these orders would make ${product.name || id} stock negative (${stock}).`);
  return { id, quantity, stock, name: String(product.name || 'Product'), branchId: product.branchId || null };
});
const customerIds = Array.from(new Set(Array.from(restoreOrderRecords.values()).map(order => String(order.customerId || '')).filter(Boolean)));
const restoreAuditId = randomUUID();
const restoredAt = Date.now();
const summary = {
  historicalAppointments: appointmentsToRestore.length,
  historicalOrders: historicalOrdersToRestore.length,
  duplicateOrders: duplicateOrdersToRestore.length,
  queueEntries: queueToRestore.length,
  stockProducts: productsToAdjust.length,
  customersToRecalculate: customerIds.length,
  revenueDeltaKES,
  revenueDeltaUSD,
  payrollWindow: { from: '2026-10-31', through: '2026-11-06' },
  currentUnpaidLines: currentEarnings.length,
  projectedUnpaidLines: projectedEarnings.length,
  currentUnpaidKES: currentEarnings.reduce((sum, line) => sum + line.amount, 0),
  projectedUnpaidKES: projectedEarnings.reduce((sum, line) => sum + line.amount, 0),
  restoredEarningsDeltaKES: earningDeltaKES,
};

if (!process.argv.includes('--confirm')) {
  console.log(JSON.stringify({ dryRun: true, ...summary, action: 'No records changed. Pass --confirm to restore only Nov 7 assistant-audited soft deletes.' }, null, 2));
} else {
  const historicalAppointmentIdsToRestore = appointmentsToRestore.map(item => String(item.id));
  const historicalOrderIdsToRestore = historicalOrdersToRestore.map(item => String(item.id));
  const duplicateSnapshots = duplicateOrdersToRestore.map(item => ({ id: item.id, record: item.record }));
  const queueIdsToRestore = queueToRestore.map(item => String(item.id));
  const stockUpdates = productsToAdjust.map(item => ({ id: item.id, stock: item.stock }));
  const stockMovements = productsToAdjust.filter(item => item.quantity !== 0).map(item => ({
    id: randomUUID(), tenantId, branchId: item.branchId, productId: item.id, productName: item.name,
    change: -item.quantity, reason: `Restored soft-deleted payroll/revenue records; restore audit ${restoreAuditId}`,
    createdAt: restoredAt, actor: 'owner',
  }));
  const customerUpdateIds = customerIds;
  const committedOrderIds = [...historicalOrderIdsToRestore, ...duplicateSnapshots.map(item => item.id)];
  const restoreAudit = {
    id: restoreAuditId, tenantId, action: 'restored assistant soft-deleted records', collection: 'audit_restore',
    actor: 'owner', recordId: null, summary: 'Restored Nov 7 assistant-audited soft deletes at owner request.',
    restoreId: restoreAuditId, recordIds: committedOrderIds, ...summary, createdAt: restoredAt,
  };
  const results = await sql.transaction(txn => [
    txn`CREATE OR REPLACE FUNCTION prevent_safigroom_committed_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE restore_id text;
      BEGIN
        IF OLD.collection IN ('orders', 'expenses', 'messages', 'audit_logs', 'notifications', 'stock_movements') THEN
          IF NEW.record ? 'deletedAt' AND NOT (OLD.record ? 'deletedAt') THEN RETURN NEW; END IF;
          restore_id := current_setting('braidysms.restore_id', true);
          IF OLD.record ? 'deletedAt' AND NOT (NEW.record ? 'deletedAt')
            AND restore_id IS NOT NULL
            AND NEW.record = OLD.record - ARRAY['deletedAt', 'deletedBy', 'voidReason', 'deletionReason', 'payoutReversalRequired']
            AND EXISTS (
              SELECT 1 FROM app_records AS restore_audit
              WHERE restore_audit.collection = 'audit_logs'
                AND restore_audit.record->>'action' = 'restored assistant soft-deleted records'
                AND restore_audit.record->>'restoreId' = restore_id
                AND restore_audit.record->'recordIds' ? OLD.id
            ) THEN RETURN NEW;
          END IF;
          RAISE EXCEPTION 'Committed SafiGroom records cannot be edited';
        END IF;
        RETURN NEW;
      END;
      $$`,
    txn`SELECT set_config('braidysms.restore_id', ${restoreAuditId}, true) AS restore_id`,
    txn`INSERT INTO app_records (id, collection, tenant_id, record)
      VALUES (${restoreAuditId}, 'audit_logs', ${tenantId}, ${JSON.stringify(restoreAudit)}::jsonb)
      RETURNING id`,
    ...(historicalAppointmentIdsToRestore.length ? [txn`
      UPDATE app_records SET record = record - 'deletedAt' - 'deletedBy' - 'deletionReason'
      WHERE collection = 'appointments' AND id = ANY(${historicalAppointmentIdsToRestore})
        AND record->>'deletedAt' = ${String(deletedAt)} AND record->>'deletionReason' = ${deletionReason}
      RETURNING id
    `] : []),
    ...(historicalOrderIdsToRestore.length ? [txn`
      UPDATE app_records SET record = record - 'deletedAt' - 'deletedBy' - 'voidReason' - 'deletionReason' - 'payoutReversalRequired'
      WHERE collection = 'orders' AND id = ANY(${historicalOrderIdsToRestore})
        AND record->>'deletedAt' = ${String(deletedAt)} AND record->>'voidReason' = ${deletionReason}
      RETURNING id
    `] : []),
    ...(duplicateSnapshots.length ? [txn`
      UPDATE app_records AS target SET record = source.record
      FROM jsonb_to_recordset(${JSON.stringify(duplicateSnapshots)}::jsonb) AS source(id text, record jsonb)
      WHERE target.collection = 'orders' AND target.id = source.id
      RETURNING target.id
    `] : []),
    ...(queueIdsToRestore.length ? [txn`
      UPDATE app_records SET record = record - 'deletedAt' - 'deletedBy'
      WHERE collection = 'queue' AND id = ANY(${queueIdsToRestore}) AND record->>'deletedAt' = ${String(deletedAt)}
      RETURNING id
    `] : []),
    ...(stockUpdates.length ? [txn`
      UPDATE app_records AS target SET record = target.record || jsonb_build_object('stock', source.stock::numeric)
      FROM jsonb_to_recordset(${JSON.stringify(stockUpdates)}::jsonb) AS source(id text, stock numeric)
      WHERE target.collection = 'products' AND target.id = source.id
      RETURNING target.id
    `] : []),
    ...(customerUpdateIds.length ? [txn`
      WITH affected AS (SELECT unnest(${customerUpdateIds}::text[]) AS customer_id),
      totals AS (
        SELECT record->>'customerId' AS customer_id,
          COALESCE(SUM(COALESCE(NULLIF(record->'totalByCurrency'->>'KES', '')::numeric, 0)), 0) AS total_spent,
          COALESCE(SUM(COALESCE(NULLIF(record->'totalByCurrency'->>'USD', '')::numeric, 0)), 0) AS total_spent_usd,
          COUNT(*)::integer AS visits,
          GREATEST(0, COALESCE(SUM(FLOOR(COALESCE(NULLIF(record->'totalByCurrency'->>'KES', '')::numeric, 0) / 100)
            - COALESCE(NULLIF(record->>'pointsRedeemed', '')::numeric, 0)), 0))::integer AS loyalty_points,
          MAX(COALESCE(NULLIF(record->>'createdAt', '')::numeric, 0)) AS last_visit
        FROM app_records WHERE collection = 'orders' AND NOT (record ? 'deletedAt')
          AND record->>'customerId' = ANY(${customerUpdateIds}) GROUP BY record->>'customerId'
      )
      UPDATE app_records AS customer SET record = customer.record || jsonb_build_object(
        'totalSpent', COALESCE(totals.total_spent, 0), 'totalSpentUSD', COALESCE(totals.total_spent_usd, 0),
        'visits', COALESCE(totals.visits, 0), 'loyaltyPoints', COALESCE(totals.loyalty_points, 0),
        'lastVisit', CASE WHEN COALESCE(totals.last_visit, 0) = 0 THEN NULL ELSE totals.last_visit END
      ) FROM affected LEFT JOIN totals USING (customer_id)
      WHERE customer.collection = 'customers' AND customer.id = affected.customer_id
      RETURNING customer.id
    `] : []),
    ...(stockMovements.length ? [txn`
      INSERT INTO app_records (id, collection, tenant_id, record)
      SELECT movement.id, 'stock_movements', movement.tenantId, to_jsonb(movement)
      FROM jsonb_to_recordset(${JSON.stringify(stockMovements)}::jsonb) AS movement(
        id text, tenantId text, branchId text, productId text, productName text, change numeric, reason text, createdAt bigint, actor text
      )
      RETURNING id
    `] : []),
    txn`CREATE OR REPLACE FUNCTION prevent_safigroom_committed_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.collection IN ('orders', 'expenses', 'messages', 'audit_logs', 'notifications', 'stock_movements')
          AND NOT (NEW.record ? 'deletedAt' AND NOT (OLD.record ? 'deletedAt')) THEN
          RAISE EXCEPTION 'Committed SafiGroom records cannot be edited';
        END IF;
        RETURN NEW;
      END;
      $$`,
  ]);
  const expectedWriteCounts = [
    0, 1, 1,
    ...(historicalAppointmentIdsToRestore.length ? [historicalAppointmentIdsToRestore.length] : []),
    ...(historicalOrderIdsToRestore.length ? [historicalOrderIdsToRestore.length] : []),
    ...(duplicateSnapshots.length ? [duplicateSnapshots.length] : []),
    ...(queueIdsToRestore.length ? [queueIdsToRestore.length] : []),
    ...(stockUpdates.length ? [stockUpdates.length] : []),
    ...(customerUpdateIds.length ? [customerUpdateIds.length] : []),
    ...(stockMovements.length ? [stockMovements.length] : []),
    0,
  ];
  const mismatchedWrites = results.flatMap((rows, index) => rows.length === expectedWriteCounts[index]
    ? [] : [{ query: index + 1, expected: expectedWriteCounts[index], actual: rows.length }]);
  if (results.length !== expectedWriteCounts.length || mismatchedWrites.length) {
    throw new Error(`Restore transaction returned unexpected row counts: ${JSON.stringify(mismatchedWrites)}`);
  }
  console.log(JSON.stringify({ restored: true, ...summary, auditId: restoreAuditId, transactionResults: results.map(rows => rows.length) }, null, 2));
}