import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateUnpaidStaffEarnings } from '../backend/earnings.ts';

const now = new Date(2026, 8, 26, 12, 0, 0).getTime();
const startOfSunday = new Date(2026, 8, 20, 0, 0, 0).getTime();
const startOfNextSunday = new Date(2026, 8, 27, 0, 0, 0).getTime();
const orderAt = (createdAt: number, item: Record<string, unknown>, extras: Record<string, unknown> = {}) => ({
  id: `order-${createdAt}`,
  createdAt,
  items: [{ type: 'service', price: 1000, qty: 1, currency: 'KES', ...item }],
  ...extras,
});

test('weekly earnings count Sunday through Saturday and exclude Sunday after today', () => {
  const orders = [
    orderAt(startOfSunday, { staffId: 'stylist', commission: 500 }),
    orderAt(startOfNextSunday - 1, { staffId: 'stylist', commission: 300 }),
    orderAt(startOfNextSunday, { staffId: 'stylist', commission: 999 }),
  ];
  const lines = calculateUnpaidStaffEarnings(orders, [], [], startOfSunday, startOfNextSunday);
  assert.deepEqual(lines.map(line => line.amount), [500, 300]);
});

test('shared earnings include every service role, payout exclusions and appointment fallback', () => {
  const order = orderAt(now, {
    name: 'Knotless braids',
    price: 1800,
    lineTotalAfterDiscount: 1800,
    commissionPct: 50,
    commissionBase: 1400,
    commission: 700,
    coStaffId: 'co',
    coStaffCommission: 350,
    thirdStaffId: 'third',
    thirdStaffCommission: 100,
    helperStaffId: 'assistant',
    assistantPayment: 200,
  }, { appointmentId: 'appointment-1' });
  const orders = [
    order,
    orderAt(now, { staffId: 'paid', commission: 400 }, { id: 'paid-order' }),
    orderAt(now, { staffId: 'deleted-order', commission: 900 }, { deletedAt: now }),
  ];
  const payouts = [{ itemKey: 'paid-order:0', staffId: 'paid' }];
  const appointments = [{ id: 'appointment-1', staffId: 'appointment-stylist', staffName: 'Linked stylist' }];
  const lines = calculateUnpaidStaffEarnings(orders, payouts, appointments, startOfSunday, startOfNextSunday);
  const totalByStaff = new Map<string, number>();
  for (const line of lines) totalByStaff.set(line.staffId, (totalByStaff.get(line.staffId) || 0) + line.amount);
  assert.deepEqual(Object.fromEntries(totalByStaff), {
    'appointment-stylist': 700,
    co: 350,
    third: 100,
    assistant: 200,
  });
  assert.equal(lines.filter(line => line.role === 'assistant')[0].amount, 200);
  assert.equal(lines.reduce((sum, line) => sum + line.amount, 0), 1350);
});

test('paid transactions reappear in unpaid calculations only after payout lines are soft-deleted', () => {
  const order = orderAt(now, { staffId: 'stylist', commission: 450 });
  const activePayout = { itemKey: 'order-1769472000000:0', staffId: 'stylist' };
  const matchingKey = `${order.id}:0`;
  const active = calculateUnpaidStaffEarnings([order], [{ ...activePayout, itemKey: matchingKey }], [], startOfSunday, startOfNextSunday);
  const cleared = calculateUnpaidStaffEarnings([order], [{ ...activePayout, itemKey: matchingKey, deletedAt: now }], [], startOfSunday, startOfNextSunday);
  assert.equal(active.length, 0);
  assert.equal(cleared.reduce((sum, line) => sum + line.amount, 0), 450);
});
