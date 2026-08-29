import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const confirmedOrderId = '242bad03-4922-4906-a9cc-9df9e0b301c2';
const voidOrderIds = [
  '522b2ef6-8774-4e14-a1ed-8e27f30c1d44',
  'ef06bde3-d859-4bea-9a82-9b25961c2d3d',
  'af631ed5-0da6-4a1a-97c0-a4d23976676c',
];

const rows = await sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND id = ANY(${[confirmedOrderId, ...voidOrderIds]})` as { id: string; record: any }[];
const byId = new Map(rows.map(row => [row.id, row]));
const confirmed = byId.get(confirmedOrderId);
if (!confirmed || String(confirmed.record?.customerName || '').toLowerCase() !== 'purity njogu' || Number(confirmed.record?.items?.[0]?.commission) !== 850 || Number(confirmed.record?.items?.[0]?.assistantPayment) !== 300) throw new Error('The confirmed Faith Conrows KES 850 transaction did not match');
const toVoid = voidOrderIds.map(id => byId.get(id)).filter((row): row is { id: string; record: any } => Boolean(row && !row.record?.deletedAt));
for (const order of toVoid) {
  if (String(order.record?.customerName || '').toLowerCase() !== 'purity njogu') throw new Error(`Unexpected client on order ${order.id}`);
}

if (toVoid.length) {
  await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
  try {
    const deletedAt = Date.now();
    for (const order of toVoid) {
      const voided = { ...order.record, deletedAt, deletedBy: 'owner', voidReason: 'Unconfirmed Faith transaction; owner retained only confirmed KES 850 Conrows sale' };
      await sql`UPDATE app_records SET record = ${JSON.stringify(voided)}::jsonb WHERE id = ${order.id} AND collection = 'orders'`;
    }
  } finally {
    await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
  }
}

console.log(JSON.stringify({ keptOrderId: confirmedOrderId, faithCommission: 850, assistantCompensation: 300, voidedOrderIds: toVoid.map(order => order.id), alreadyVoided: voidOrderIds.filter(id => byId.get(id)?.record?.deletedAt) }, null, 2));