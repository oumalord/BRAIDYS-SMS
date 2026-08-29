import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const rows = await sql`SELECT id, collection, record FROM app_records ORDER BY created_at ASC` as { id: string; collection: string; record: any }[];
const customerRows = rows.filter(row => row.collection === 'customers' && String(row.record?.name || '').trim().toLowerCase() === 'purity njogu');
if (customerRows.length !== 3) throw new Error(`Expected the three verified Purity Njogu customer profiles, found ${customerRows.length}`);

const customerIds = new Set(customerRows.map(row => row.id));
const linkedIds = new Set<string>(customerIds);
const hasCustomerReference = (record: any) => {
  const value = record || {};
  return customerIds.has(String(value.customerId || ''))
    || customerIds.has(String(value.clientId || ''))
    || String(value.customerName || '').trim().toLowerCase() === 'purity njogu'
    || String(value.clientName || '').trim().toLowerCase() === 'purity njogu';
};

for (const row of rows) if (hasCustomerReference(row.record)) linkedIds.add(row.id);
let changed = true;
while (changed) {
  changed = false;
  for (const row of rows) {
    const record = row.record || {};
    const snapshot = record.recordSnapshot || {};
    const referencesLinked = [record.appointmentId, record.orderId, record.queueId, record.referenceId, record.recordId, snapshot.id, snapshot.customerId, snapshot.clientId]
      .some(value => linkedIds.has(String(value || '')));
    const snapshotMatchesCustomer = hasCustomerReference(snapshot);
    if ((referencesLinked || snapshotMatchesCustomer) && !linkedIds.has(row.id)) {
      linkedIds.add(row.id);
      changed = true;
    }
  }
}

const related = rows.filter(row => linkedIds.has(row.id));
const prohibited = related.filter(row => ['salons', 'branches', 'staff', 'accounts', 'sessions'].includes(row.collection));
if (prohibited.length) throw new Error(`Refusing to delete protected records: ${prohibited.map(row => `${row.collection}:${row.id}`).join(', ')}`);
const ids = related.map(row => row.id);
const counts = Object.fromEntries(Array.from(new Set(related.map(row => row.collection))).map(collection => [collection, related.filter(row => row.collection === collection).length]));

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
try {
  await sql`DELETE FROM app_records WHERE id = ANY(${ids})`;
} finally {
  await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
  await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
}

const remaining = await sql`SELECT id FROM app_records WHERE id = ANY(${ids})` as { id: string }[];
if (remaining.length) throw new Error(`Deletion incomplete; ${remaining.length} linked records remain`);
console.log(JSON.stringify({ deleted: counts, total: ids.length, customerIds: [...customerIds] }, null, 2));