import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const customers = await sql`
  SELECT id, collection, record
  FROM app_records
  WHERE collection = 'customers' AND lower(record->>'name') = 'purity njogu'
` as { id: string; collection: string; record: any }[];
const rows = await sql`SELECT id, collection, record FROM app_records ORDER BY collection, created_at ASC` as { id: string; collection: string; record: any }[];
if (!customers.length) throw new Error('Purity Njogu customer records were not found');

const customerIds = new Set(customers.map(customer => customer.id));
const related = rows.filter(row => {
  const record = row.record || {};
  return customerIds.has(row.id)
    || customerIds.has(String(record.customerId || ''))
    || customerIds.has(String(record.clientId || ''))
    || String(record.customerName || '').trim().toLowerCase() === 'purity njogu'
    || String(record.clientName || '').trim().toLowerCase() === 'purity njogu';
});
const counts = Object.fromEntries(Array.from(new Set(related.map(row => row.collection))).map(collection => [collection, related.filter(row => row.collection === collection).length]));
console.log(JSON.stringify({ customers: customers.map(customer => ({ id: customer.id, name: customer.record.name, phone: customer.record.phone, email: customer.record.email })), counts, records: related.map(row => ({ id: row.id, collection: row.collection, customerId: row.record?.customerId || null, customerName: row.record?.customerName || null, appointmentId: row.record?.appointmentId || null, deletedAt: row.record?.deletedAt || null })) }, null, 2));