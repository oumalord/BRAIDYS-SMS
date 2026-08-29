import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const rows = await sql`SELECT id, collection, record FROM app_records ORDER BY collection, created_at ASC` as { id: string; collection: string; record: any }[];
const customers = rows.filter(row => row.collection === 'customers' && String(row.record?.name || '').trim().toLowerCase() === 'charmaine mutare');
if (!customers.length) throw new Error('Charmaine Mutare customer records were not found');

const customerIds = new Set(customers.map(row => row.id));
const related = rows.filter(row => customerIds.has(row.id)
  || customerIds.has(String(row.record?.customerId || ''))
  || customerIds.has(String(row.record?.clientId || ''))
  || String(row.record?.customerName || '').trim().toLowerCase() === 'charmaine mutare'
  || String(row.record?.clientName || '').trim().toLowerCase() === 'charmaine mutare');
const counts = Object.fromEntries(Array.from(new Set(related.map(row => row.collection))).map(collection => [collection, related.filter(row => row.collection === collection).length]));
console.log(JSON.stringify({ customers: customers.map(row => ({ id: row.id, name: row.record.name, phone: row.record.phone, email: row.record.email })), counts, records: related.map(row => ({ id: row.id, collection: row.collection, customerId: row.record?.customerId || null, customerName: row.record?.customerName || null, appointmentId: row.record?.appointmentId || null })) }, null, 2));