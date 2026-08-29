import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
function assistantCompensation(serviceFee: number): number {
  if (serviceFee <= 1800) return 200;
  if (serviceFee <= 2400) return 300;
  if (serviceFee <= 3300) return 400;
  return 500;
}

const [staffRows, orderRows] = await Promise.all([
  sql`SELECT id, record FROM app_records WHERE collection = 'staff' AND lower(record->>'name') = 'adolphine' LIMIT 1`,
  sql`SELECT id, record FROM app_records WHERE collection = 'orders' ORDER BY created_at ASC`,
]) as any[];
const adolphine = staffRows[0];
if (!adolphine) throw new Error('Adolphine staff record was not found');

const lines: any[] = [];
for (const order of orderRows as { id: string; record: any }[]) {
  for (const [index, item] of (order.record?.items || []).entries()) {
    if (item.type !== 'service') continue;
    const role = item.staffId === adolphine.id ? 'primary' : item.coStaffId === adolphine.id ? 'co-staff' : item.helperStaffId === adolphine.id ? 'assistant' : null;
    if (!role) continue;
    const serviceFee = Number(item.price || 0) * Number(item.qty || 1);
    const assistantPayment = item.helperStaffId ? assistantCompensation(serviceFee) : 0;
    const serviceRevenue = Number(item.lineTotalAfterDiscount ?? serviceFee) || 0;
    const productCost = Math.max(0, Number(item.productCost || 0));
    const commissionBase = Math.max(0, serviceRevenue - productCost - assistantPayment);
    const rate = Number(item.commissionPct ?? item.commissionRate ?? 50);
    const expectedCommission = commissionBase * (Number.isFinite(rate) ? rate / 100 : 0.5);
    const expectedEarning = role === 'assistant' ? assistantPayment : expectedCommission;
    const storedEarning = role === 'assistant' ? Number(item.assistantPayment ?? item.helperDeduction ?? 0) : Number(item.commission || 0);
    lines.push({ orderId: order.id, customerName: order.record.customerName, createdAt: order.record.createdAt, index, role, service: item.name, serviceFee, rate, productCost, assistantName: item.helperStaffName || null, expectedAssistantPayment: assistantPayment, storedAssistantPayment: Number(item.assistantPayment ?? item.helperDeduction ?? 0), expectedCommission, storedCommission: Number(item.commission || 0), expectedEarning, storedEarning });
  }
}

const expectedTotal = lines.reduce((sum, line) => sum + line.expectedEarning, 0);
const storedTotal = lines.reduce((sum, line) => sum + line.storedEarning, 0);
const mismatches = lines.filter(line => line.storedEarning !== line.expectedEarning || (line.role !== 'assistant' && line.storedAssistantPayment !== line.expectedAssistantPayment));
console.log(JSON.stringify({ staff: adolphine.record.name, serviceLines: lines, storedTotal, expectedTotal, mismatchCount: mismatches.length, mismatches }, null, 2));