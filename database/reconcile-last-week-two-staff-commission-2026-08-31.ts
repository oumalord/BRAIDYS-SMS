import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const OLD_RATE = 33.33;
const NEW_RATE = 33.35;
const RATE_EPSILON = 0.01;

function previousWeekRange(now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() - ((end.getDay() + 6) % 7));
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return { start: start.getTime(), end: end.getTime() };
}

function isAutomaticCommission(value: unknown, expected: number) {
  return value === undefined || value === null || Math.abs(Number(value) - expected) < RATE_EPSILON;
}

const { start, end } = previousWeekRange();
const [serviceRows, orderRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'services' AND NOT (record ? 'deletedAt')`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders' AND NOT (record ? 'deletedAt')`,
]) as [{ id: string; record: any }[], { id: string; record: any }[]];

const serviceUpdates = serviceRows
  .filter(row => Number(row.record?.commissionPct) === OLD_RATE)
  .map(row => ({ id: row.id, record: { ...row.record, commissionPct: NEW_RATE } }));

const staffEarnings = new Map<string, { name: string; commission: number; assistant: number }>();
const addEarnings = (staffId: unknown, name: unknown, field: 'commission' | 'assistant', amount: unknown) => {
  if (!staffId) return;
  const id = String(staffId);
  const entry = staffEarnings.get(id) || { name: String(name || 'Unknown staff'), commission: 0, assistant: 0 };
  entry[field] += Math.max(0, Number(amount) || 0);
  staffEarnings.set(id, entry);
};

const orderUpdates: { id: string; record: any }[] = [];
for (const row of orderRows) {
  const order = row.record || {};
  if (Number(order.createdAt || 0) < start || Number(order.createdAt || 0) >= end) continue;
  let changed = false;
  const items = (Array.isArray(order.items) ? order.items : []).map((item: any) => {
    if (item.type !== 'service') return item;
    const rate = Number(item.commissionPct ?? item.commissionRate);
    let corrected = item;
    if (rate === OLD_RATE) {
      const commissionBase = Math.max(0, Number(item.commissionBase || 0));
      const oldCommission = commissionBase * (OLD_RATE / 100);
      const newCommission = commissionBase * (NEW_RATE / 100);
      const primaryIsAutomatic = isAutomaticCommission(item.primaryCommission, oldCommission);
      const coStaffIsAutomatic = isAutomaticCommission(item.coStaffCommission, oldCommission);
      corrected = {
        ...item,
        commissionPct: NEW_RATE,
        commissionRate: NEW_RATE,
        primaryCommission: primaryIsAutomatic ? newCommission : item.primaryCommission,
        coStaffCommission: item.coStaffId && coStaffIsAutomatic ? newCommission : item.coStaffCommission,
        commission: primaryIsAutomatic ? newCommission : item.commission,
      };
      changed = true;
    }
    addEarnings(corrected.staffId, corrected.staffName, 'commission', corrected.primaryCommission ?? corrected.commission);
    addEarnings(corrected.coStaffId, corrected.coStaffName, 'commission', corrected.coStaffCommission);
    addEarnings(corrected.helperStaffId, corrected.helperStaffName, 'assistant', corrected.assistantPayment ?? corrected.helperDeduction);
    return corrected;
  });
  if (changed) orderUpdates.push({ id: row.id, record: { ...order, items } });
}

if (serviceUpdates.length || orderUpdates.length) {
  await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;
  try {
    for (const update of serviceUpdates) await sql`UPDATE app_records SET record = ${JSON.stringify(update.record)}::jsonb WHERE id = ${update.id} AND collection = 'services'`;
    for (const update of orderUpdates) await sql`UPDATE app_records SET record = ${JSON.stringify(update.record)}::jsonb WHERE id = ${update.id} AND collection = 'orders'`;
  } finally {
    await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;
  }
}

console.log(JSON.stringify({
  period: { from: new Date(start).toISOString(), to: new Date(end).toISOString() },
  updatedServices: serviceUpdates.length,
  updatedOrders: orderUpdates.length,
  staffEarnings: Array.from(staffEarnings.values()).sort((left, right) => left.name.localeCompare(right.name)).map(entry => ({ ...entry, total: entry.commission + entry.assistant })),
}, null, 2));