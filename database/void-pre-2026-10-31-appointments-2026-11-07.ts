import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const databaseUrl = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const tenantId = 'salon-852a7423ca75d9db';
const branchId = 'salon-852a7423ca75d9db-main';
const cutoffDate = '2026-10-31';
const payrollFrom = Date.parse('2026-10-31T00:00:00+03:00');
const payrollTo = Date.parse('2026-11-07T00:00:00+03:00');
const reason = 'Owner requested removal of appointments before 2026-10-31 and their locally settled revenues from active finance and payroll.';
const sql = neon(databaseUrl);
if (process.argv.includes('--status')) {
  const [appointmentStatus, linkedOrderStatus, auditStatus, customerStatus] = await Promise.all([
    sql`SELECT
      COUNT(*) FILTER (WHERE NOT (record ? 'deletedAt'))::integer AS active,
      COUNT(*) FILTER (WHERE record ? 'deletedAt')::integer AS deleted
    FROM app_records
    WHERE collection = 'appointments'
      AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
      AND record->>'date' < ${cutoffDate}
      AND (record->>'branchId' = ${branchId} OR record->>'branchId' IS NULL OR record->>'branchId' = '')`,
    sql`SELECT
      COUNT(*) FILTER (WHERE NOT (o.record ? 'deletedAt'))::integer AS active,
      COUNT(*) FILTER (WHERE o.record ? 'deletedAt')::integer AS deleted
    FROM app_records o
    JOIN app_records a ON a.id = o.record->>'appointmentId' AND a.collection = 'appointments'
    WHERE o.collection = 'orders'
      AND (o.tenant_id = ${tenantId} OR o.record->>'tenantId' = ${tenantId})
      AND (a.tenant_id = ${tenantId} OR a.record->>'tenantId' = ${tenantId})
      AND a.record->>'date' < ${cutoffDate}
      AND (a.record->>'branchId' = ${branchId} OR a.record->>'branchId' IS NULL OR a.record->>'branchId' = '')`,
    sql`SELECT COUNT(*)::integer AS count FROM app_records
      WHERE collection = 'audit_logs' AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
      AND record->>'summary' = 'soft-deleted appointments before 2026-10-31 and voided linked orders'`,
    sql`WITH affected AS (
      SELECT DISTINCT o.record->>'customerId' AS customer_id
      FROM app_records o
      JOIN app_records a ON a.id = o.record->>'appointmentId' AND a.collection = 'appointments'
      WHERE o.collection = 'orders'
        AND (o.tenant_id = ${tenantId} OR o.record->>'tenantId' = ${tenantId})
        AND NULLIF(o.record->>'customerId', '') IS NOT NULL
        AND (a.tenant_id = ${tenantId} OR a.record->>'tenantId' = ${tenantId})
        AND a.record->>'date' < ${cutoffDate}
        AND (a.record->>'branchId' = ${branchId} OR a.record->>'branchId' IS NULL OR a.record->>'branchId' = '')
    ), active_totals AS (
      SELECT record->>'customerId' AS customer_id,
        COALESCE(SUM(COALESCE(NULLIF(record->'totalByCurrency'->>'KES', '')::numeric, 0)), 0) AS total_spent,
        COALESCE(SUM(COALESCE(NULLIF(record->'totalByCurrency'->>'USD', '')::numeric, 0)), 0) AS total_spent_usd,
        COUNT(*)::integer AS visits,
        GREATEST(0, COALESCE(SUM(FLOOR(COALESCE(NULLIF(record->'totalByCurrency'->>'KES', '')::numeric, 0) / 100)
          - COALESCE(NULLIF(record->>'pointsRedeemed', '')::numeric, 0)), 0))::integer AS loyalty_points,
        MAX(COALESCE(NULLIF(record->>'createdAt', '')::numeric, 0)) AS last_visit
      FROM app_records
      WHERE collection = 'orders'
        AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
        AND NOT (record ? 'deletedAt')
        AND record->>'customerId' IN (SELECT customer_id FROM affected)
      GROUP BY record->>'customerId'
    )
    SELECT COUNT(*)::integer AS affected,
      COUNT(*) FILTER (
        WHERE COALESCE(NULLIF(c.record->>'totalSpent', '')::numeric, 0) <> COALESCE(t.total_spent, 0)
          OR COALESCE(NULLIF(c.record->>'totalSpentUSD', '')::numeric, 0) <> COALESCE(t.total_spent_usd, 0)
          OR COALESCE(NULLIF(c.record->>'visits', '')::integer, 0) <> COALESCE(t.visits, 0)
          OR COALESCE(NULLIF(c.record->>'loyaltyPoints', '')::integer, 0) <> COALESCE(t.loyalty_points, 0)
          OR COALESCE(NULLIF(c.record->>'lastVisit', '')::numeric, 0) <> COALESCE(t.last_visit, 0)
      )::integer AS mismatched,
      ARRAY_AGG(c.id) FILTER (
        WHERE COALESCE(NULLIF(c.record->>'totalSpent', '')::numeric, 0) <> COALESCE(t.total_spent, 0)
          OR COALESCE(NULLIF(c.record->>'totalSpentUSD', '')::numeric, 0) <> COALESCE(t.total_spent_usd, 0)
          OR COALESCE(NULLIF(c.record->>'visits', '')::integer, 0) <> COALESCE(t.visits, 0)
          OR COALESCE(NULLIF(c.record->>'loyaltyPoints', '')::integer, 0) <> COALESCE(t.loyalty_points, 0)
          OR COALESCE(NULLIF(c.record->>'lastVisit', '')::numeric, 0) <> COALESCE(t.last_visit, 0)
      ) AS mismatched_ids
    FROM affected a
    JOIN app_records c ON c.collection = 'customers' AND c.id = a.customer_id
      AND (c.tenant_id = ${tenantId} OR c.record->>'tenantId' = ${tenantId})
    LEFT JOIN active_totals t ON t.customer_id = a.customer_id`,
  ]) as any[][];
  console.log(JSON.stringify({
    appointments: appointmentStatus[0], linkedOrders: linkedOrderStatus[0],
    affectedCustomers: customerStatus[0]?.affected || 0,
    customersWithStaleTotals: customerStatus[0]?.mismatched || 0,
    staleCustomerIds: customerStatus[0]?.mismatched_ids || [],
    cleanupAuditEntries: auditStatus[0]?.count || 0,
  }, null, 2));
  process.exit(0);
}
if (process.argv.includes('--repair-customer-totals')) {
  const updates = await sql`
    WITH affected AS (
      SELECT DISTINCT o.record->>'customerId' AS customer_id
      FROM app_records o
      JOIN app_records a ON a.id = o.record->>'appointmentId' AND a.collection = 'appointments'
      WHERE o.collection = 'orders'
        AND (o.tenant_id = ${tenantId} OR o.record->>'tenantId' = ${tenantId})
        AND NULLIF(o.record->>'customerId', '') IS NOT NULL
        AND (a.tenant_id = ${tenantId} OR a.record->>'tenantId' = ${tenantId})
        AND a.record->>'date' < ${cutoffDate}
        AND (a.record->>'branchId' = ${branchId} OR a.record->>'branchId' IS NULL OR a.record->>'branchId' = '')
    ), active_totals AS (
      SELECT record->>'customerId' AS customer_id,
        COALESCE(SUM(COALESCE(NULLIF(record->'totalByCurrency'->>'KES', '')::numeric, 0)), 0) AS total_spent,
        COALESCE(SUM(COALESCE(NULLIF(record->'totalByCurrency'->>'USD', '')::numeric, 0)), 0) AS total_spent_usd,
        COUNT(*)::integer AS visits,
        GREATEST(0, COALESCE(SUM(FLOOR(COALESCE(NULLIF(record->'totalByCurrency'->>'KES', '')::numeric, 0) / 100)
          - COALESCE(NULLIF(record->>'pointsRedeemed', '')::numeric, 0)), 0))::integer AS loyalty_points,
        MAX(COALESCE(NULLIF(record->>'createdAt', '')::numeric, 0)) AS last_visit
      FROM app_records
      WHERE collection = 'orders'
        AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
        AND NOT (record ? 'deletedAt')
        AND record->>'customerId' IN (SELECT customer_id FROM affected)
      GROUP BY record->>'customerId'
    )
    UPDATE app_records c
    SET record = c.record || jsonb_build_object(
      'totalSpent', COALESCE(t.total_spent, 0)::numeric,
      'totalSpentUSD', COALESCE(t.total_spent_usd, 0)::numeric,
      'visits', COALESCE(t.visits, 0)::integer,
      'loyaltyPoints', COALESCE(t.loyalty_points, 0)::integer,
      'lastVisit', CASE WHEN COALESCE(t.last_visit, 0) = 0 THEN NULL ELSE t.last_visit::bigint END
    )
    FROM affected a
    LEFT JOIN active_totals t ON t.customer_id = a.customer_id
    WHERE c.collection = 'customers'
      AND c.id = a.customer_id
      AND (c.tenant_id = ${tenantId} OR c.record->>'tenantId' = ${tenantId})
    RETURNING c.id
  ` as { id: string }[];
  if (updates.length !== 786) throw new Error(`Expected to recalculate 786 historical customers, updated ${updates.length}`);
  const auditId = randomUUID();
  await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (
    ${auditId}, 'audit_logs', ${tenantId}, ${JSON.stringify({
      id: auditId, tenantId, branchId, action: 'recalculated customer totals after historical appointment removal',
      collection: 'customer', actor: 'owner', recordId: null,
      summary: 'recalculated 786 customer totals from remaining active orders after removing pre-2026-10-31 appointments',
      customerCount: updates.length, createdAt: Date.now(),
    })}::jsonb
  )`;
  console.log(JSON.stringify({ repaired: true, customersRecalculated: updates.length, auditId }, null, 2));
  process.exit(0);
}

const appointmentRows = await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'appointments'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
    AND record->>'date' < ${cutoffDate}
    AND (record->>'branchId' = ${branchId} OR record->>'branchId' IS NULL OR record->>'branchId' = '')
` as any[];
const appointments = appointmentRows.map(row => ({ ...row.record, id: String(row.id) }));
const appointmentIds = appointments.map(item => String(item.id));
const orderRows = appointmentIds.length ? await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'orders'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND record->>'appointmentId' = ANY(${appointmentIds})
` as any[] : [];
const orders = orderRows.map(row => ({ ...row.record, id: String(row.id) }));
const orderIds = Array.from(new Set(orders.map(order => String(order.id))));
const activeAppointments = appointments.filter(item => !item.deletedAt);
const activeOrders = orders.filter(item => !item.deletedAt);
const activeOrderIds = new Set(activeOrders.map(order => String(order.id)));
const customerIds = Array.from(new Set(activeOrders.map(order => String(order.customerId || '')).filter(Boolean)));
const productQuantities = new Map<string, number>();
for (const order of activeOrders) {
  for (const item of order.items || []) {
    if (item.type === 'product' && item.refId) productQuantities.set(String(item.refId), (productQuantities.get(String(item.refId)) || 0) + Number(item.qty || 0));
    for (const used of item.consumedProducts || []) {
      if (used.productId) productQuantities.set(String(used.productId), (productQuantities.get(String(used.productId)) || 0) + Number(used.qty || 0));
    }
  }
}
const productIds = Array.from(productQuantities.keys());
const products = productIds.length ? await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'products'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND id = ANY(${productIds})
` as any[] : [];
if (products.length !== productIds.length) throw new Error(`Missing inventory records: expected ${productIds.length}, found ${products.length}`);

const earningKeys = orders.flatMap(order => (order.items || []).flatMap((item: any, index: number) => item.type === 'service'
  ? [`${order.id}:${index}`, `${order.id}:${index}:co-staff`, `${order.id}:${index}:third-staff`, `${order.id}:${index}:assistant`]
  : []));
const payoutRows = orderIds.length ? await sql`
  SELECT id, record FROM app_records
  WHERE collection = 'payout_items'
    AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
    AND (record->>'orderId' = ANY(${orderIds}) OR record->>'itemKey' = ANY(${earningKeys}))
` as any[] : [];
const activePayouts = payoutRows.map(row => ({ ...row.record, id: String(row.id) })).filter(item => !item.deletedAt);
if (activePayouts.length) throw new Error(`Found ${activePayouts.length} active payout markers on these locally settled historical orders; refusing to remove them from payroll without reconciliation`);

const lines = calculateUnpaidStaffEarnings(activeOrders, [], appointments, payrollFrom, payrollTo);
const payrollLines = lines.filter(line => line.currency === 'KES');
const historicalRevenueKES = activeOrders.reduce((sum, order) => sum + Number(order.totalByCurrency?.KES || 0), 0);
const unpaidKES = payrollLines.reduce((sum, line) => sum + line.amount, 0);
const expected = {
  appointments: 1226,
  activeAppointments: 988,
  linkedOrders: 1135,
  activeOrders: 994,
  affectedCustomers: 713,
  historicalRevenueKES: 2645060,
  payrollLines: 169,
  payrollEarningsKES: 66800,
};
if (appointments.length !== expected.appointments
  || activeAppointments.length !== expected.activeAppointments
  || orders.length !== expected.linkedOrders
  || activeOrders.length !== expected.activeOrders
  || customerIds.length !== expected.affectedCustomers
  || historicalRevenueKES !== expected.historicalRevenueKES
  || payrollLines.length !== expected.payrollLines
  || unpaidKES !== expected.payrollEarningsKES) {
  throw new Error(`Refusing cleanup because preflight changed: appointments=${appointments.length}/${activeAppointments.length}, orders=${orders.length}/${activeOrders.length}, customers=${customerIds.length}, revenue=${historicalRevenueKES}, payroll=${payrollLines.length}/${unpaidKES}`);
}

const statusCounts = Object.fromEntries(Array.from(new Set(appointments.filter(item => !item.deletedAt).map(item => String(item.status || 'unknown'))))
  .map(status => [status, appointments.filter(item => !item.deletedAt && String(item.status || 'unknown') === status).length]));
const confirmed = process.argv.includes('--confirm');
if (!confirmed) {
  console.log(JSON.stringify({
    dryRun: true,
    branch: 'Main Branch',
    cutoffExclusive: cutoffDate,
    appointments: appointments.length,
    alreadyDeletedAppointments: appointments.length - activeAppointments.length,
    appointmentsToSoftDelete: activeAppointments.length,
    activeAppointmentsByStatus: statusCounts,
    linkedOrders: orders.length,
    activeOrdersToVoid: activeOrders.length,
    alreadyDeletedOrders: orders.length - activeOrders.length,
    locallySettledRevenueToRemoveKES: historicalRevenueKES,
    customersToRecalculate: customerIds.length,
    stockProductsToRestore: productIds.length,
    activePayoutMarkers: activePayouts.length,
    payrollWindow: { from: '2026-10-31', through: '2026-11-06', unpaidLinesToRemove: payrollLines.length, unpaidKES: unpaidKES },
    ordersCreatedInPayrollWindow: activeOrders.filter(order => Number(order.createdAt || 0) >= payrollFrom && Number(order.createdAt || 0) < payrollTo).length,
    action: 'No records changed. Pass --confirm to soft-delete all appointments and linked active orders before Oct 31 for Main Branch.',
  }, null, 2));
} else {
  const deletedAt = Date.now();
  const appointmentUpdates = await sql`
    UPDATE app_records
    SET record = record || jsonb_build_object(
      'deletedAt', ${deletedAt}::bigint,
      'deletedBy', 'owner',
      'deletionReason', ${reason}::text
    )
    WHERE collection = 'appointments'
      AND id = ANY(${appointmentIds})
      AND NOT (record ? 'deletedAt')
      AND record->>'date' < ${cutoffDate}
    RETURNING id
  ` as { id: string }[];
  if (appointmentUpdates.length !== activeAppointments.length) throw new Error(`Appointment deletion count mismatch: ${appointmentUpdates.length}/${activeAppointments.length}`);

  const orderUpdates = await sql`
    UPDATE app_records
    SET record = record || jsonb_build_object(
      'deletedAt', ${deletedAt}::bigint,
      'deletedBy', 'owner',
      'voidReason', ${reason}::text,
      'payoutReversalRequired', false
    )
    WHERE collection = 'orders'
      AND id = ANY(${Array.from(activeOrderIds)})
      AND NOT (record ? 'deletedAt')
    RETURNING id
  ` as { id: string }[];
  if (orderUpdates.length !== activeOrders.length) throw new Error(`Order deletion count mismatch: ${orderUpdates.length}/${activeOrders.length}`);

  for (const product of products) {
    const id = String(product.id);
    const quantity = productQuantities.get(id) || 0;
    const updatedStock = Number(product.record?.stock || 0) + quantity;
    await sql`UPDATE app_records SET record = record || jsonb_build_object('stock', ${updatedStock}::numeric) WHERE collection = 'products' AND id = ${id}`;
    if (quantity !== 0) {
      const movementId = randomUUID();
      await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (
        ${movementId}, 'stock_movements', ${tenantId}, ${JSON.stringify({
          id: movementId, tenantId, branchId, productId: id, productName: product.record?.name || 'Product',
          change: quantity, reason, createdAt: deletedAt, actor: 'owner',
        })}::jsonb
      )`;
    }
  }

  if (customerIds.length) {
    const aggregates = await sql`
      SELECT
        record->>'customerId' AS customer_id,
        COALESCE(SUM(COALESCE(NULLIF(record->'totalByCurrency'->>'KES', '')::numeric, 0)), 0) AS total_spent,
        COALESCE(SUM(COALESCE(NULLIF(record->'totalByCurrency'->>'USD', '')::numeric, 0)), 0) AS total_spent_usd,
        COUNT(*)::integer AS visits,
        GREATEST(0, COALESCE(SUM(FLOOR(COALESCE(NULLIF(record->'totalByCurrency'->>'KES', '')::numeric, 0) / 100)
          - COALESCE(NULLIF(record->>'pointsRedeemed', '')::numeric, 0)), 0))::integer AS loyalty_points,
        MAX(COALESCE(NULLIF(record->>'createdAt', '')::numeric, 0)) AS last_visit
      FROM app_records
      WHERE collection = 'orders'
        AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
        AND NOT (record ? 'deletedAt')
        AND record->>'customerId' = ANY(${customerIds})
      GROUP BY record->>'customerId'
    ` as any[];
    const byCustomer = new Map(aggregates.map(row => [String(row.customer_id), row]));
    for (const customerId of customerIds) {
      const totals = byCustomer.get(customerId);
      const [customerRow] = await sql`
        SELECT id FROM app_records
        WHERE collection = 'customers' AND id = ${customerId}
          AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
      ` as any[];
      if (!customerRow) continue;
      await sql`
        UPDATE app_records
        SET record = record || jsonb_build_object(
          'totalSpent', ${Number(totals?.total_spent || 0)}::numeric,
          'totalSpentUSD', ${Number(totals?.total_spent_usd || 0)}::numeric,
          'visits', ${Number(totals?.visits || 0)}::integer,
          'loyaltyPoints', ${Number(totals?.loyalty_points || 0)}::integer,
          'lastVisit', ${totals?.last_visit ? Number(totals.last_visit) : null}::bigint
        )
        WHERE collection = 'customers' AND id = ${customerId}
      `;
    }
  }

  const queueIds = await sql`
    UPDATE app_records
    SET record = record || jsonb_build_object('deletedAt', ${deletedAt}::bigint, 'deletedBy', 'owner')
    WHERE collection = 'queue'
      AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
      AND record->>'appointmentId' = ANY(${appointmentIds})
      AND NOT (record ? 'deletedAt')
    RETURNING id
  ` as { id: string }[];
  const auditId = randomUUID();
  const summary = {
    id: auditId, tenantId, branchId, action: 'deleted appointments before cutoff with linked revenues',
    collection: 'appointments', actor: 'owner', recordId: null,
    summary: `soft-deleted appointments before ${cutoffDate} and voided linked orders`,
    cutoffDate, appointmentIds, orderIds: Array.from(activeOrderIds), queueIds: queueIds.map(row => row.id),
    appointmentCount: activeAppointments.length, orderCount: activeOrders.length,
    revenueKES: historicalRevenueKES, payrollEarningsKES: unpaidKES, createdAt: deletedAt,
  };
  await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${auditId}, 'audit_logs', ${tenantId}, ${JSON.stringify(summary)}::jsonb)`;

  const remaining = await sql`
    SELECT COUNT(*)::integer AS count FROM app_records
    WHERE collection = 'appointments'
      AND (tenant_id = ${tenantId} OR record->>'tenantId' = ${tenantId})
      AND record->>'date' < ${cutoffDate}
      AND NOT (record ? 'deletedAt')
      AND (record->>'branchId' = ${branchId} OR record->>'branchId' IS NULL OR record->>'branchId' = '')
  ` as any[];
  if (Number(remaining[0]?.count || 0) !== 0) throw new Error(`Verification failed: ${remaining[0]?.count} pre-cutoff appointments remain active`);
  console.log(JSON.stringify({
    deleted: true,
    cutoffExclusive: cutoffDate,
    appointmentsSoftDeleted: appointmentUpdates.length,
    linkedOrdersVoided: orderUpdates.length,
    queueEntriesDeleted: queueIds.length,
    customersRecalculated: customerIds.length,
    inventoryProductsRestored: products.length,
    locallySettledRevenueRemovedKES: historicalRevenueKES,
    payrollEarningsRemovedKES: unpaidKES,
    activePreCutoffAppointmentsRemaining: Number(remaining[0]?.count || 0),
    auditId,
    reason,
  }, null, 2));
}