import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const customerId = '65ec7af0-d7fb-4347-8046-906e22166864';
const appointmentId = 'f5a8e731-ed57-48ec-9914-bd10a24250c3';
const orderId = 'b7249582-d76f-4ff3-ac47-a56d42e584cb';
const queueId = '9643a01a-ec36-43d4-9dd4-ced516bca4dd';
const targetIds = [customerId, appointmentId, orderId, queueId];
const existing = await sql`SELECT id FROM app_records WHERE id = ANY(${targetIds})` as { id: string }[];
if (existing.length) throw new Error(`Restore stopped: record IDs already exist (${existing.map(row => row.id).join(', ')})`);

const auditRows = await sql`SELECT record FROM app_records WHERE collection = 'audit_logs' AND record->>'recordId' = ANY(${targetIds}) ORDER BY created_at ASC` as { record: any }[];
const snapshots = new Map(auditRows.map(row => [row.record.recordId, row.record.recordSnapshot]));
const customerSnapshot = snapshots.get(customerId);
const appointmentSnapshot = snapshots.get(appointmentId);
const orderSnapshot = snapshots.get(orderId);
const queueSnapshot = snapshots.get(queueId);
if (!customerSnapshot || !appointmentSnapshot || !orderSnapshot || !queueSnapshot) throw new Error('Restore stopped: one or more Charmaine audit snapshots are missing');
if (String(customerSnapshot.name || '').trim().toLowerCase() !== 'charmaine mutare' || String(appointmentSnapshot.customerId || '') !== customerId || String(orderSnapshot.customerName || '').trim().toLowerCase() !== 'charmaine mutare' || String(queueSnapshot.customerId || '') !== customerId) throw new Error('Restore stopped: audit snapshots do not match the verified Charmaine record set');

const orderCreatedAt = Number(auditRows.find(row => row.record.recordId === orderId)?.record.createdAt || Date.now());
const customer = { ...customerSnapshot, id: customerId, tenantId: appointmentSnapshot.tenantId, salonName: appointmentSnapshot.salonName, branchId: appointmentSnapshot.branchId, notes: '', loyaltyPoints: Math.floor(Number(orderSnapshot.totalByCurrency?.KES || 0) / 100), totalSpent: Number(orderSnapshot.totalByCurrency?.KES || 0), totalSpentUSD: 0, visits: 1, lastVisit: orderCreatedAt, createdAt: Number(customerSnapshot.createdAt || orderCreatedAt), membershipTier: 'none', membershipExpiry: null };
const appointment = { ...appointmentSnapshot, id: appointmentId, status: 'completed' };
const queue = { ...queueSnapshot, id: queueId, status: 'completed' };
const order = { ...orderSnapshot, id: orderId, customerId, createdAt: orderCreatedAt, tenantId: appointmentSnapshot.tenantId, salonName: appointmentSnapshot.salonName, branchId: appointmentSnapshot.branchId, helperDeductions: (orderSnapshot.items || []).reduce((sum: number, item: any) => sum + (item.type === 'service' ? Number(item.assistantPayment || 0) : 0), 0), productCostTotal: 0, discountPct: 0, discountSource: 'none', promoCode: null, pointsRedeemed: 0, mpesaReceiptNumber: null };

await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${customerId}, 'customers', ${appointmentSnapshot.tenantId}, ${JSON.stringify(customer)}::jsonb)`;
await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${appointmentId}, 'appointments', ${appointmentSnapshot.tenantId}, ${JSON.stringify(appointment)}::jsonb)`;
await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${queueId}, 'queue', ${appointmentSnapshot.tenantId}, ${JSON.stringify(queue)}::jsonb)`;
await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${orderId}, 'orders', ${appointmentSnapshot.tenantId}, ${JSON.stringify(order)}::jsonb)`;

console.log(JSON.stringify({ restored: { customerId, appointmentId, queueId, orderId }, customerName: customer.name, totalKES: order.totalByCurrency?.KES || 0 }, null, 2));