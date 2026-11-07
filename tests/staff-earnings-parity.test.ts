import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateUnpaidStaffEarnings, currentSundayThroughNowRange, mostRecentSaturdayThroughFridayRange, previousSaturdayThroughYesterdayRange, staffAppointmentMinutes } from '../backend/earnings.ts';

const now = new Date(2026, 8, 26, 12, 0, 0).getTime();
const startOfSunday = new Date(2026, 8, 20, 0, 0, 0).getTime();
const startOfNextSunday = new Date(2026, 8, 27, 0, 0, 0).getTime();
const orderAt = (createdAt: number, item: Record<string, unknown>, extras: Record<string, unknown> = {}) => ({
  id: `order-${createdAt}`,
  createdAt,
  items: [{ type: 'service', price: 1000, qty: 1, currency: 'KES', ...item }],
  ...extras,
});

test('payroll date range is the previous Saturday through yesterday in Nairobi', () => {
  const range = previousSaturdayThroughYesterdayRange(new Date('2026-10-31T12:00:00+03:00'));
  assert.equal(new Date(range.from).toISOString(), '2026-10-23T21:00:00.000Z');
  assert.equal(new Date(range.to).toISOString(), '2026-10-30T21:00:00.000Z');
  const orders = [
    orderAt(range.from, { staffId: 'stylist', commission: 100 }),
    orderAt(range.to - 1, { staffId: 'stylist', commission: 200 }),
    orderAt(range.to, { staffId: 'stylist', commission: 300 }),
  ];
  const lines = calculateUnpaidStaffEarnings(orders, [], [], range.from, range.to);
  assert.deepEqual(lines.map(line => line.amount), [100, 200]);
});

test('completed earnings period is Saturday through Friday in Nairobi', () => {
  const range = mostRecentSaturdayThroughFridayRange(new Date('2026-11-07T12:00:00+03:00'));
  assert.equal(new Date(range.from).toISOString(), '2026-10-30T21:00:00.000Z');
  assert.equal(new Date(range.to).toISOString(), '2026-11-06T21:00:00.000Z');
  const orders = [
    orderAt(range.from, { staffId: 'stylist', commission: 100 }),
    orderAt(range.to - 1, { staffId: 'stylist', commission: 200 }),
    orderAt(range.to, { staffId: 'stylist', commission: 300 }),
  ];
  const lines = calculateUnpaidStaffEarnings(orders, [], [], range.from, range.to);
  assert.deepEqual(lines.map(line => line.amount), [100, 200]);
});

test('current earnings range is Sunday through the current instant in Nairobi', () => {
  const now = new Date('2026-10-31T18:13:00+03:00');
  const range = currentSundayThroughNowRange(now);
  assert.equal(new Date(range.from).toISOString(), '2026-10-24T21:00:00.000Z');
  assert.equal(new Date(range.to).toISOString(), '2026-10-31T15:13:00.001Z');
});

test('earnings calculation includes the start and excludes the end of its requested range', () => {
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

test('cancelled and deleted appointments exclude all linked order earnings', () => {
  const orders = [
    orderAt(now, { staffId: 'cancelled-staff', commission: 300 }, { id: 'cancelled-order', appointmentId: 'cancelled-appointment' }),
    orderAt(now, { staffId: 'deleted-staff', commission: 400 }, { id: 'deleted-order', appointmentId: 'deleted-appointment' }),
    orderAt(now, { staffId: 'no-show-staff', commission: 500 }, { id: 'no-show-order', appointmentId: 'no-show-appointment' }),
    orderAt(now, { staffId: 'active-staff', commission: 600 }, { id: 'active-order', appointmentId: 'active-appointment' }),
    orderAt(now, { staffId: 'walk-in-staff', commission: 700 }, { id: 'walk-in-order' }),
  ];
  const appointments = [
    { id: 'cancelled-appointment', status: 'cancelled' },
    { id: 'deleted-appointment', status: 'completed', deletedAt: now },
    { id: 'no-show-appointment', status: 'no-show' },
    { id: 'active-appointment', status: 'completed' },
  ];
  const lines = calculateUnpaidStaffEarnings(orders, [], appointments, startOfSunday, startOfNextSunday);
  assert.deepEqual(lines.map(line => line.staffId), ['active-staff', 'walk-in-staff']);
  assert.deepEqual(lines.map(line => line.amount), [600, 700]);
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

test('appointment minutes use assigned service durations and legacy primary-staff fallback', () => {
  assert.equal(staffAppointmentMinutes({ staffId: 'primary', durationMin: 60, items: [{ durationMin: 30 }, { durationMin: 30 }] }, 'primary'), 60);
  assert.equal(staffAppointmentMinutes({ staffId: 'primary', durationMin: 60, items: [{ staffId: 'primary', durationMin: 35 }, { staffId: 'other', durationMin: 25 }] }, 'primary'), 35);
  assert.equal(staffAppointmentMinutes({ staffId: 'other', durationMin: 60, items: [{ staffId: 'primary', durationMin: 35 }, { staffId: 'other', durationMin: 25 }] }, 'primary'), 35);
});
