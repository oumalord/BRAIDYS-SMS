import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const rows = await sql`SELECT id, record FROM app_records WHERE collection = 'audit_logs' ORDER BY created_at ASC` as { id: string; record: any }[];
const names = new Set(['charmaine mutare', 'purity njogu']);
const matching = rows.filter(row => {
  const record = row.record || {};
  const snapshot = record.recordSnapshot || {};
  return names.has(String(snapshot.customerName || snapshot.name || '').trim().toLowerCase())
    || names.has(String(record.summary || '').replace(/^.*?:\s*/, '').trim().toLowerCase());
});
console.log(JSON.stringify(matching.map(row => ({ id: row.id, action: row.record.action, collection: row.record.collection, recordId: row.record.recordId, summary: row.record.summary, snapshot: row.record.recordSnapshot, createdAt: row.record.createdAt })), null, 2));
console.log(`Matching audit snapshots: ${matching.length}`);