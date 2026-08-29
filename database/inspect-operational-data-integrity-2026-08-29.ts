import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const collections = ['staff', 'services', 'products', 'customers', 'appointments', 'orders'];
const records = Object.fromEntries(await Promise.all(collections.map(async collection => [collection, await sql`SELECT id, record FROM app_records WHERE collection = ${collection}` as { id: string; record: any }[]])) as Record<string, { id: string; record: any }[]>);
const active = (collection: string) => records[collection].filter(row => !row.record?.deletedAt);
const staffIds = new Set(active('staff').map(row => row.id));
const serviceIds = new Set(active('services').map(row => row.id));
const customerIds = new Set(active('customers').map(row => row.id));
const appointments = active('appointments');
const missingStaff = appointments.filter(row => row.record?.staffId && !staffIds.has(row.record.staffId)).map(row => row.id);
const missingServices = appointments.filter(row => row.record?.serviceId && !serviceIds.has(row.record.serviceId)).map(row => row.id);
const missingCustomers = appointments.filter(row => row.record?.customerId && !customerIds.has(row.record.customerId)).map(row => row.id);

console.log(JSON.stringify({
  counts: Object.fromEntries(collections.map(collection => [collection, { active: active(collection).length, softDeleted: records[collection].length - active(collection).length }])),
  appointmentLinkIssues: { missingStaff, missingServices, missingCustomers },
}, null, 2));