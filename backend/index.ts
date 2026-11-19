import { router, json, error, db, ai, storage, currentContext, withRequestContext } from './runtime.ts';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { calculateUnpaidStaffEarnings, currentSaturdayThroughFridayRange, currentSundayThroughNowRange, mostRecentSaturdayThroughFridayRange, paystackConfirmedPayoutItems, staffAppointmentMinutes, staffCommission } from './earnings.ts';
import { hasSufficientPaystackPrincipalBalance, toPaystackMinorAmount, verifyPaystackSignature } from './paystack.ts';

const DAY = 24 * 3600 * 1000;
const DEFAULT_STAFF_PIN = '1234';
const ATTENDANCE_LOCATION = { latitude: -1.2154173, longitude: 36.888536 };
const ATTENDANCE_RADIUS_METERS = 300;
const KAMAKIS_ATTENDANCE_LOCATION = { latitude: -1.1679375, longitude: 36.9682031 };
const KAMAKIS_ATTENDANCE_RADIUS_METERS = 200;
const ATTENDANCE_ROLES = ['owner', 'admin', 'manager', 'receptionist', 'barber'];

function saturdayFridayRange(date = new Date()) {
  const current = new Date(date);
  const daysSinceSaturday = (current.getDay() + 1) % 7;
  const fromDate = new Date(current);
  fromDate.setDate(current.getDate() - daysSinceSaturday);
  fromDate.setHours(0, 0, 0, 0);
  const toDate = new Date(fromDate);
  toDate.setDate(fromDate.getDate() + 7);
  return { from: fromDate.getTime(), to: toDate.getTime() };
}

function contextIncludesPayrollRecord(record: any, context: { tenantId: string; role?: string }) {
  return context.role !== 'admin' || record.tenantId === context.tenantId;
}

function branchScopedPayrollOrders(orders: any[], appointments: any[], staffById: Map<string, any>, context: { tenantId: string; branchId?: string | null; role?: string }) {
  const appointmentsById = new Map(appointments.filter(appointment => !appointment.deletedAt && contextIncludesPayrollRecord(appointment, context)).map(appointment => [String(appointment.id), appointment]));
  return orders.filter(order => {
    if (!contextIncludesPayrollRecord(order, context)) return false;
    if (!context.branchId) return true;
    const appointment = appointmentsById.get(String(order.appointmentId || ''));
    const orderBranch = order.branchId || appointment?.branchId;
    if (orderBranch) return orderBranch === context.branchId;
    return (Array.isArray(order.items) ? order.items : []).some((item: any) => [item.staffId, item.coStaffId, item.thirdStaffId, item.helperStaffId]
      .some(staffId => staffById.get(String(staffId || ''))?.branchId === context.branchId));
  });
}

function branchScopedPayrollPayoutItems(payoutItems: any[], context: { tenantId: string; branchId?: string | null; role?: string }) {
  return payoutItems.filter(item => contextIncludesPayrollRecord(item, context) && (!context.branchId || !item.branchId || item.branchId === context.branchId));
}

function nairobiDayRange(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (calendarDay.toISOString().slice(0, 10) !== date) return null;
  const from = Date.UTC(year, month - 1, day) - 3 * 60 * 60 * 1000;
  return { from, to: from + DAY };
}

function nairobiDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find(value => value.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function attendanceRecordId(accountId: string, date: string) {
  return `attendance-${createHash('sha256').update(`${accountId}:${date}`).digest('hex')}`;
}

function attendancePolicy(branchName?: string) {
  return branchName?.toLowerCase().includes('kamakis')
    ? { location: KAMAKIS_ATTENDANCE_LOCATION, radiusMeters: KAMAKIS_ATTENDANCE_RADIUS_METERS, name: branchName }
    : { location: ATTENDANCE_LOCATION, radiusMeters: ATTENDANCE_RADIUS_METERS, name: 'Braidy Saloon, Lumumba Drive' };
}

function attendanceDistanceMeters(latitude: number, longitude: number, location: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(latitude - location.latitude);
  const longitudeDelta = radians(longitude - location.longitude);
  const arc = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(location.latitude)) * Math.cos(radians(latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function verifiedAttendanceLocation(body: any, branchName?: string): { ok: false; error: string } | { ok: true, distanceMeters: number } {
  const latitude = Number(body?.latitude);
  const longitude = Number(body?.longitude);
  const accuracy = Number(body?.accuracy);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { ok: false, error: 'A valid device location is required' };
  }
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 150) return { ok: false, error: 'Location accuracy is too low. Try again outdoors.' };
  const policy = attendancePolicy(branchName);
  const distanceMeters = attendanceDistanceMeters(latitude, longitude, policy.location);
  if (distanceMeters + accuracy > policy.radiusMeters) {
    const message = branchName?.toLowerCase().includes('kamakis')
      ? 'You must be within 200 metres of the Kamakis location to record attendance.'
      : 'You are not at your work station so check in at your location';
    return { ok: false, error: message };
  }
  return { ok: true, distanceMeters: Math.round(distanceMeters) };
}

function passwordHash(password: string, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password: string, stored: string) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function sessionToken() { return randomBytes(32).toString('hex'); }
const PLATFORM_ADMIN_ID = 'account-platform-admin';
const PLATFORM_ADMIN_EMAIL = 'sirlordphick@gmail.com';
const PLATFORM_ADMIN_PASSWORD = 'Lord9632@@';

export async function ensurePlatformAdmin() {
  const [account] = await db.get('accounts', [PLATFORM_ADMIN_ID]);
  const platformAdmin = { id: PLATFORM_ADMIN_ID, tenantId: 'platform', salonName: 'All Salons', branchId: '', name: 'Platform Admin', email: PLATFORM_ADMIN_EMAIL, role: 'admin', status: 'active', passwordHash: passwordHash(PLATFORM_ADMIN_PASSWORD), createdAt: account?.createdAt || Date.now() };
  if (!account) await db.add('accounts', [platformAdmin]);
  else await db.update('accounts', [{ id: PLATFORM_ADMIN_ID, record: { ...account, ...platformAdmin } }]);
}

function normalizeRole(role: unknown): string {
  const value = String(role || '').trim().toLowerCase();
  if (['owner', 'manager', 'receptionist', 'barber', 'customer', 'admin'].includes(value)) return value;
  if (value.includes('reception')) return 'receptionist';
  if (value.includes('manager')) return 'manager';
  return 'barber';
}
function serviceStaffCount(value: unknown): 1 | 2 {
  return Number(value) === 2 ? 2 : 1;
}
function commissionPct(value: unknown, staffCount?: unknown): 30 | 33.35 | 40 | 50 {
  const rate = Number(value);
  if (rate === 30 || rate === 33.35 || rate === 40 || rate === 50) return rate;
  return serviceStaffCount(staffCount) === 2 ? 33.35 : 50;
}
function sameStaffIdentity(staffId: unknown, staffName: unknown, context: { staffId?: string; name: string }): boolean {
  if (staffId && String(staffId) === String(context.staffId || '')) return true;
  const normalize = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return Boolean(staffName && context.name && normalize(staffName) === normalize(context.name));
}
function sessionRecord(token: string, account: any) {
  return { id: createHash('sha256').update(token).digest('hex'), accountId: account.id, tenantId: account.tenantId, expiresAt: Date.now() + 7 * DAY, createdAt: Date.now() };
}

function requireAdmin() {
  if (currentContext()?.role !== 'admin') throw new Error('Administrator access is required');
}

function requireOwner() {
  if (!['owner', 'admin'].includes(currentContext()?.role || '')) throw new Error('Only the owner or administrator can edit records');
}

async function hasReceptionistAppointmentPrivileges(context = currentContext()) {
  if (context?.role !== 'receptionist') return false;
  return true;
}

function createTicketNumber(date: string): string {
  const datePart = date.replace(/[^0-9]/g, '').slice(-4);
  const randomPart = String(Math.floor(1000 + Math.random() * 9000));
  return `SG-${datePart}-${randomPart}`;
}
function appointmentCardNumber(value: unknown): string {
  const cardNumber = String(value || '').trim();
  if (cardNumber && !/^\d{1,30}$/.test(cardNumber)) throw new Error('Card number must contain digits only');
  return cardNumber;
}
function normalizeCustomerPhone(value: unknown) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.startsWith('0') ? `254${digits.slice(1)}` : digits;
}

function normalizeCustomerName(value: unknown) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function appointmentBelongsToBranch(appointment: any, branchId: string, branchName: string) {
  const appointmentBranchId = String(appointment.branchId || '').trim();
  if (appointmentBranchId) return appointmentBranchId === branchId;
  return Boolean(branchName) && String(appointment.branchName || '').trim().toLocaleLowerCase() === branchName.trim().toLocaleLowerCase();
}

function hasSameDayCustomerDetails(appointment: any, date: string, name: unknown, phone: unknown, cardNumber: string) {
  return !appointment.deletedAt
    && appointment.date === date
    && normalizeCustomerName(appointment.customerName) === normalizeCustomerName(name)
    && normalizeCustomerPhone(appointment.customerPhone || appointment.phone) === normalizeCustomerPhone(phone)
    && String(appointment.cardNumber || '').trim() === cardNumber;
}

function findOrderForAppointment(orders: any[], appointment: any) {
  const activeOrders = orders.filter(order => !order.deletedAt);
  const linkedOrder = activeOrders.find(order => String(order.appointmentId || '') === String(appointment.id));
  if (linkedOrder) return linkedOrder;

  const dateRange = nairobiDayRange(String(appointment.date || ''));
  if (!dateRange) return null;
  const serviceIds = new Set([appointment.serviceId, ...(Array.isArray(appointment.items) ? appointment.items.map((item: any) => item.serviceId) : [])].filter(Boolean).map(String));
  const serviceNames = new Set([appointment.serviceName, ...(Array.isArray(appointment.items) ? appointment.items.map((item: any) => item.serviceName) : [])]
    .filter(Boolean).map((name: unknown) => String(name).trim().toLowerCase()));
  const customerName = String(appointment.customerName || '').trim().toLowerCase();
  const candidates = activeOrders.filter(order => {
    const sameCustomer = appointment.customerId
      ? String(order.customerId || '') === String(appointment.customerId)
      : String(order.customerName || '').trim().toLowerCase() === customerName;
    const createdAt = Number(order.createdAt || 0);
    const matchingService = Array.isArray(order.items) && order.items.some((item: any) => item.type === 'service'
      && (serviceIds.has(String(item.refId || '')) || serviceNames.has(String(item.name || '').trim().toLowerCase())));
    return sameCustomer && createdAt >= dateRange.from && createdAt < dateRange.to && matchingService;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function isPaystackRecipientEligible(staffMember: any, accountRole = '') {
  if (staffMember.deletedAt || ['laid-off', 'permanently-deleted'].includes(String(staffMember.employmentStatus || ''))) return false;
  const roles = [staffMember.role, accountRole].map(role => String(role || '').trim().toLowerCase());
  return !roles.some(role => role.includes('admin'));
}

async function createPaystackStaffRecipient(staffMember: any): Promise<string> {
  const secretKey = String(process.env.PAYSTACK_SECRET_KEY || '');
  if (!secretKey.startsWith('sk_live_')) throw new Error('Live Paystack credentials are required to create staff recipients.');
  const phone = normalizeCustomerPhone(staffMember.phone);
  if (!/^254[17]\d{8}$/.test(phone)) throw new Error(`Enter a valid Kenyan mobile number for ${staffMember.name}.`);
  const response = await fetch('https://api.paystack.co/transferrecipient', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'mobile_money', name: staffMember.name, account_number: phone, bank_code: 'MPESA', currency: 'KES', description: `BRAIDY SALON staff ${staffMember.id}`, metadata: { staffId: staffMember.id } }),
  });
  const result: any = await response.json().catch(() => ({}));
  const recipient = result?.data;
  if (!response.ok || !result.status || !/^RCP_[A-Za-z0-9]+$/.test(String(recipient?.recipient_code || '')) || recipient.currency !== 'KES' || recipient.type !== 'mobile_money') {
    throw new Error(result.message || `Paystack could not register ${staffMember.name} as an M-PESA recipient.`);
  }
  return recipient.recipient_code;
}

async function createPaystackStaffRecipients(staffMembers: any[]) {
  const recipientCodesByPhone = new Map<string, string>();
  const failures: { member: any; error: string }[] = [];
  const validMembers = staffMembers.flatMap(member => {
    const phone = normalizeCustomerPhone(member.phone);
    if (!/^254[17]\d{8}$/.test(phone)) {
      failures.push({ member, error: `Enter a valid Kenyan mobile number for ${member.name}.` });
      return [];
    }
    return [{ member, phone }];
  });
  if (!validMembers.length) return { recipientCodesByPhone, failures };

  const response = await fetch('https://api.paystack.co/transferrecipient/bulk', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch: validMembers.map(({ member, phone }) => ({
      type: 'mobile_money', name: member.name, account_number: phone, bank_code: 'MPESA', currency: 'KES',
      description: `BRAIDY SALON staff ${member.id}`, metadata: { staffId: member.id },
    })) }),
  });
  const result: any = await response.json().catch(() => ({}));
  const requestSucceeded = response.ok && Boolean(result?.status);
  const providerFailures = Array.isArray(result?.data?.errors) ? result.data.errors : [];
  const successRows = Array.isArray(result?.data?.success) ? result.data.success : [];
  for (const recipient of requestSucceeded ? successRows : []) {
    const phone = normalizeCustomerPhone(recipient?.details?.account_number);
    const code = String(recipient?.recipient_code || '');
    if (/^254[17]\d{8}$/.test(phone) && /^RCP_[A-Za-z0-9]+$/.test(code)) recipientCodesByPhone.set(phone, code);
  }

  const providerMessage = String(providerFailures[0]?.message || result?.message || 'Paystack could not register this M-PESA recipient.');
  for (const { member, phone } of validMembers) {
    if (!requestSucceeded || !recipientCodesByPhone.has(phone)) failures.push({ member, error: providerMessage });
  }
  return { recipientCodesByPhone, failures };
}

async function notifyCustomer(email: string | undefined, subject: string, message: string, referenceId: string) {
  if (!email) return;
  await db.add('notifications', [{ email, subject, message, referenceId, status: 'queued', createdAt: Date.now() }]);
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject, text: message }),
    });
  } catch (cause) {
    console.error('Email delivery failed', cause);
  }
}

async function notifyEmployee(staff: any, employmentStatus: 'active' | 'laid-off', initialPassword?: string) {
  if (!staff.accountEmail) return;
  const subject = employmentStatus === 'laid-off' ? 'BRAIDY SALON employment update' : 'Welcome back to BRAIDY SALON';
  const message = employmentStatus === 'laid-off'
    ? `Hello ${staff.name},\n\nThis email confirms that your employment with BRAIDY SALON has ended, effective immediately. Please contact the business owner if you have questions about your final commission statement.`
    : `Hello ${staff.name},\n\nThis email confirms that you are employed by BRAIDY SALON again. Your compensation is 50% commission after product and helper deductions.${initialPassword ? `\n\nLogin email: ${staff.accountEmail}\nTemporary password: ${initialPassword}\nPlease change this password after signing in.` : ''}`;
  await notifyCustomer(staff.accountEmail, subject, message, staff.id);
}

async function audit(action: string, collection: string, record: any, actor = 'system') {
  await db.add('audit_logs', [{
    action, collection, actor: currentContext()?.name || actor, recordId: record?.id || null,
    summary: `${action} ${collection}${record?.name ? `: ${record.name}` : record?.customerName ? `: ${record.customerName}` : ''}`,
    recordSnapshot: record,
    createdAt: Date.now(),
  }]);
}

async function voidOrdersForAppointments(appointments: any[], deletedAt: number, deletedBy: string, reason: string) {
  const context = currentContext();
  if (!context?.tenantId) throw new Error('Salon context is required to void appointment orders');
  const appointmentIds = new Set(appointments.map(appointment => String(appointment.id)));
  const { items: allOrders } = await db.listAllTenant('orders', context.tenantId, { limit: 5000, branchScope: false });
  const ordersToVoid = (allOrders as any[]).filter(order => !order.deletedAt && appointmentIds.has(String(order.appointmentId || '')));
  if (!ordersToVoid.length) return { orderIds: [], payoutReversalRequired: false };

  const { items: payoutItems } = await db.list('payout_items', { limit: 10000 });
  const orderIds = new Set(ordersToVoid.map(order => String(order.id)));
  const paidOrderIds = new Set((payoutItems as any[])
    .filter(item => !item.deletedAt && orderIds.has(String(item.orderId || '')))
    .map(item => String(item.orderId)));
  const productQuantities = new Map<string, number>();
  for (const order of ordersToVoid) {
    for (const item of order.items || []) {
      if (item.type === 'product' && item.refId) productQuantities.set(String(item.refId), (productQuantities.get(String(item.refId)) || 0) + Number(item.qty || 0));
      for (const used of item.consumedProducts || []) {
        if (used.productId) productQuantities.set(String(used.productId), (productQuantities.get(String(used.productId)) || 0) + Number(used.qty || 0));
      }
    }
  }
  const productIds = Array.from(productQuantities.keys());
  if (productIds.length) {
    const products = await db.get('products', productIds);
    const updates = products.flatMap((product, index) => product ? [{
      id: productIds[index],
      record: { ...product, stock: Number(product.stock || 0) + (productQuantities.get(productIds[index]) || 0) },
    }] : []);
    if (updates.length) await db.update('products', updates);
    const movements = updates.map(update => ({
      productId: update.id,
      productName: update.record.name,
      change: productQuantities.get(update.id) || 0,
      reason,
      createdAt: deletedAt,
      actor: deletedBy,
    })).filter(movement => movement.change !== 0);
    if (movements.length) await db.add('stock_movements', movements);
  }

  await db.update('orders', ordersToVoid.map(order => ({
    id: String(order.id),
    record: {
      ...order,
      deletedAt,
      deletedBy,
      voidReason: reason,
      payoutReversalRequired: paidOrderIds.has(String(order.id)),
    },
  })));

  const customerIds = Array.from(new Set(ordersToVoid.map(order => String(order.customerId || '')).filter(Boolean)));
  if (customerIds.length) {
    const customers = await db.get('customers', customerIds);
    const remainingOrders = (allOrders as any[]).filter(order => !order.deletedAt && !orderIds.has(String(order.id)));
    const customerUpdates = customers.flatMap(customer => {
      if (!customer) return [];
      const customerOrders = remainingOrders.filter(order => String(order.customerId || '') === String(customer.id));
      return [{
        id: String(customer.id),
        record: {
          ...customer,
          totalSpent: customerOrders.reduce((sum, order) => sum + Number(order.totalByCurrency?.KES || 0), 0),
          totalSpentUSD: customerOrders.reduce((sum, order) => sum + Number(order.totalByCurrency?.USD || 0), 0),
          visits: customerOrders.length,
          loyaltyPoints: Math.max(0, customerOrders.reduce((sum, order) => sum + Math.floor(Number(order.totalByCurrency?.KES || 0) / 100) - Number(order.pointsRedeemed || 0), 0)),
          lastVisit: customerOrders.reduce((latest, order) => Math.max(latest, Number(order.createdAt || 0)), 0) || null,
        },
      }];
    });
    if (customerUpdates.length) await db.update('customers', customerUpdates);
  }

  for (const order of ordersToVoid) {
    await audit('voided order for inactive appointment', 'order', {
      id: String(order.id), appointmentId: String(order.appointmentId), reason,
      payoutReversalRequired: paidOrderIds.has(String(order.id)),
    }, deletedBy);
  }
  return { orderIds: Array.from(orderIds), payoutReversalRequired: paidOrderIds.size > 0 };
}

async function deleteQueuesForAppointments(appointments: any[], deletedAt: number, deletedBy: string) {
  const appointmentIds = new Set(appointments.map(appointment => String(appointment.id)));
  const { items } = await db.list('queue', { limit: 5000 });
  const queueEntries = (items as any[]).filter(item => !item.deletedAt && appointmentIds.has(String(item.appointmentId || '')));
  if (queueEntries.length) {
    await db.update('queue', queueEntries.map(item => ({
      id: String(item.id), record: { ...item, deletedAt, deletedBy },
    })));
  }
  return queueEntries.map(item => String(item.id));
}

function buildPriceListServices() {
  return [
    { name: 'Finger Twists', category: 'Salon', price: 1500, currency: 'KES', durationMin: 120, description: '' },
    { name: 'Knotless Braids', category: 'Salon', price: 2500, currency: 'KES', durationMin: 180, description: '' },
    { name: 'Stitch Lines', category: 'Salon', price: 3000, currency: 'KES', durationMin: 150, description: '' },
    { name: 'Box Braids', category: 'Salon', price: 2500, currency: 'KES', durationMin: 150, description: '' },
    { name: 'Fancy Cornrows', category: 'Salon', price: 3000, currency: 'KES', durationMin: 90, description: '' },
    { name: 'Passion Twists', category: 'Salon', price: 3000, currency: 'KES', durationMin: 150, description: '' },
    { name: 'Goddess Braids', category: 'Salon', price: 3500, currency: 'KES', durationMin: 150, description: '' },
    { name: 'Natural Hair Sisterlocks Retouch', category: 'Salon', price: 4500, currency: 'KES', durationMin: 90, description: '' },
    { name: 'Natural Hair Sisterlocks', category: 'Salon', price: 30000, currency: 'KES', durationMin: 480, description: '' },
    { name: '1/2 Cornrows 1/2 Braids', category: 'Salon', price: 2500, currency: 'KES', durationMin: 120, description: '' },
    { name: '1/2 Stitch Lines 1/2 Braids', category: 'Salon', price: 3000, currency: 'KES', durationMin: 120, description: '' },
    { name: 'Chemical Application', category: 'Salon', price: 2500, currency: 'KES', durationMin: 60, description: '' },
    { name: 'Gypsy Locs', category: 'Salon', price: 3000, currency: 'KES', durationMin: 150, description: '' },
    { name: 'Spring Twists', category: 'Salon', price: 3500, currency: 'KES', durationMin: 150, description: '' },
    { name: 'Butterfly Locs', category: 'Salon', price: 5000, currency: 'KES', durationMin: 180, description: '' },
    { name: 'Locs Retouch', category: 'Salon', price: 1500, currency: 'KES', durationMin: 60, description: '' },
    { name: 'Nubian Twists', category: 'Salon', price: 3500, currency: 'KES', durationMin: 150, description: '' },
    { name: 'Afro Kinky Twists', category: 'Salon', price: 2500, currency: 'KES', durationMin: 120, description: '' },
    { name: 'Boho Braids', category: 'Salon', price: 2000, currency: 'KES', durationMin: 120, description: '' },
    { name: 'Plain Twists', category: 'Salon', price: 1500, currency: 'KES', durationMin: 90, description: '' },
    { name: 'Plain Drop Lines', category: 'Salon', price: 1000, currency: 'KES', durationMin: 60, description: '' },
    { name: 'French Curl Braids', category: 'Salon', price: 3500, currency: 'KES', durationMin: 150, description: '' },
    { name: 'Wash & Blowdry', category: 'Salon', price: 500, currency: 'KES', durationMin: 30, description: '' },
    { name: 'Classic Haircut', category: 'Barber', price: 30, currency: 'USD', durationMin: 30, description: '' },
    { name: 'Scissor Cut', category: 'Barber', price: 32, currency: 'USD', durationMin: 35, description: '' },
    { name: "Gentleman's Cut & Style", category: 'Barber', price: 40, currency: 'USD', durationMin: 40, description: '' },
    { name: 'Buzz Cut (One Length)', category: 'Barber', price: 25, currency: 'USD', durationMin: 20, description: '' },
    { name: 'Crew Cut', category: 'Barber', price: 28, currency: 'USD', durationMin: 25, description: '' },
    { name: 'Hot Towel Shave', category: 'Barber', price: 30, currency: 'USD', durationMin: 30, description: '' },
    { name: 'Straight Razor Shave', category: 'Barber', price: 35, currency: 'USD', durationMin: 35, description: '' },
    { name: 'Beard Trim & Shape Up', category: 'Barber', price: 20, currency: 'USD', durationMin: 20, description: '' },
    { name: 'Head Shave (Straight Razor)', category: 'Barber', price: 30, currency: 'USD', durationMin: 30, description: '' },
    { name: 'Mustache Trim & Styling', category: 'Barber', price: 15, currency: 'USD', durationMin: 10, description: '' },
    { name: 'Beard Conditioning & Oil Treatment', category: 'Barber', price: 18, currency: 'USD', durationMin: 15, description: '' },
    { name: 'Haircut + Beard Trim + Hot Towel Shave', category: 'Barber', price: 75, currency: 'USD', durationMin: 70, description: '' },
    { name: 'Haircut + Complimentary Whiskey Glass', category: 'Barber', price: 50, currency: 'USD', durationMin: 40, description: '' },
    { name: 'Father & Son Haircuts', category: 'Barber', price: 55, currency: 'USD', durationMin: 50, description: '' },
    { name: "Senior Gentleman's Cut", category: 'Barber', price: 55, currency: 'USD', durationMin: 35, description: '' },
    { name: 'Kids Cut (Under 12)', category: 'Barber', price: 25, currency: 'USD', durationMin: 25, description: '' },
    { name: 'Haircut + Beard Trim + Facial Treatment', category: 'Barber', price: 85, currency: 'USD', durationMin: 75, description: '' },
    { name: 'Skin Fade', category: 'Barber', price: 35, currency: 'USD', durationMin: 40, description: '' },
  ];
}

async function migrateExistingData(staffList: any[]) {
  const staffUpdates: any[] = [];
  for (const s of staffList) {
    if (s.monthlySalary !== undefined || s.commissionPct !== 50 || s.employmentStatus === undefined || s.accountStatus === undefined || s.accountEmail === undefined) {
      const record = { ...s, employmentStatus: s.employmentStatus ?? 'active', accountEmail: s.accountEmail ?? '', accountStatus: s.accountStatus ?? 'pending', commissionPct: 50 };
      delete record.monthlySalary;
      staffUpdates.push({ id: s.id, record });
    }
  }
  if (staffUpdates.length) await db.update('staff', staffUpdates);

  const { items: services } = await db.list('services', { limit: 500 });
  const serviceUpdates: any[] = [];
  for (const sv of services as any[]) {
    if (!sv.currency) serviceUpdates.push({ id: sv.id, record: { ...sv, currency: 'KES' } });
  }
  if (serviceUpdates.length) await db.update('services', serviceUpdates);

  const existingNames = new Set((services as any[]).map(s => `${s.name}|${s.currency || 'KES'}`.toLowerCase()));
  const newServices = buildPriceListServices().filter(s => !existingNames.has(`${s.name}|${s.currency}`.toLowerCase()));
  if (newServices.length) await db.add('services', newServices);

  const { items: customers } = await db.list('customers', { limit: 1000 });
  const custUpdates: any[] = [];
  for (const c of customers as any[]) {
    if (c.totalSpentUSD === undefined || c.membershipTier === undefined) {
      custUpdates.push({ id: c.id, record: { ...c, totalSpentUSD: c.totalSpentUSD ?? 0, membershipTier: c.membershipTier ?? 'none', membershipExpiry: c.membershipExpiry ?? null } });
    }
  }
  if (custUpdates.length) await db.update('customers', custUpdates);

  const { items: existingPlans } = await db.list('membership_plans', { limit: 20 });
  if (existingPlans.length === 0) {
    await db.add('membership_plans', [
      { name: 'Bronze', discountPct: 5, priceKES: 1000, durationDays: 30, benefits: ['5% off every visit', 'Loyalty points', 'Birthday offer'] },
      { name: 'Silver', discountPct: 10, priceKES: 2500, durationDays: 30, benefits: ['10% off every visit', 'Priority booking', 'Exclusive offers'] },
      { name: 'Gold', discountPct: 15, priceKES: 5000, durationDays: 30, benefits: ['15% off every visit', 'Priority booking', 'Premium support', 'Birthday rewards'] },
    ]);
  }

  const { items: existingPromos } = await db.list('promotions', { limit: 20 });
  if (existingPromos.length === 0) {
    const today = new Date();
    const in30 = new Date(today.getTime() + 30 * DAY);
    await db.add('promotions', [
      { title: 'Tuesday Barber Special', description: '15% off all barber services on Tuesdays.', discountPct: 15, code: 'TUESDAY15', startDate: today.toISOString().slice(0, 10), endDate: in30.toISOString().slice(0, 10), requiresApproval: false, approved: true, active: true, createdBy: 'owner', createdAt: Date.now() },
      { title: 'New Customer Offer', description: '10% off for first-time customers.', discountPct: 10, code: 'WELCOME10', startDate: today.toISOString().slice(0, 10), endDate: in30.toISOString().slice(0, 10), requiresApproval: true, approved: false, active: true, createdBy: 'receptionist', createdAt: Date.now() },
    ]);
  }

  const { items: existingReviews } = await db.list('reviews', { limit: 20 });
  if (existingReviews.length === 0 && staffList.length) {
    const kevin = (staffList as any[]).find(s => s.name === 'Kevin Otieno');
    const faith = (staffList as any[]).find(s => s.name === 'Faith Njeri');
    const amina = (staffList as any[]).find(s => s.name === 'Amina Hassan');
    const seedReviews: any[] = [];
    if (kevin) seedReviews.push({ appointmentId: null, customerId: null, customerName: 'James Kariuki', staffId: kevin.id, staffName: kevin.name, serviceName: 'Skin Fade', rating: 5, comment: 'Best fade in town, always sharp.', createdAt: Date.now() - 2 * DAY });
    if (faith) seedReviews.push({ appointmentId: null, customerId: null, customerName: 'Susan Achieng', staffId: faith.id, staffName: faith.name, serviceName: 'Swedish Massage', rating: 5, comment: 'So relaxing, highly recommend.', createdAt: Date.now() - 5 * DAY });
    if (amina) seedReviews.push({ appointmentId: null, customerId: null, customerName: 'Lilian Wambui', staffId: amina.id, staffName: amina.name, serviceName: 'Box Braids (Medium)', rating: 4, comment: 'Lovely work, took a little longer than expected.', createdAt: Date.now() - 8 * DAY });
    if (seedReviews.length) await db.add('reviews', seedReviews);
  }
}

async function seedDemoData() {
  const now = Date.now();

  const [kevinId, brianId, aminaId, graceId, faithId] = await db.add('staff', [
    { name: 'Kevin Otieno', role: 'Barber', specialties: ['Fades', 'Beard Grooming'], branch: 'Nakuru CBD', chair: 'Chair 1', phone: '+254712345601', commissionPct: 40, employmentStatus: 'active', accountEmail: '', accountStatus: 'pending', status: 'available' },
    { name: 'Brian Mwangi', role: 'Barber', specialties: ['Classic Cuts', 'Kids Cuts'], branch: 'Nakuru CBD', chair: 'Chair 2', phone: '+254712345602', commissionPct: 40, employmentStatus: 'active', accountEmail: '', accountStatus: 'pending', status: 'in-service' },
    { name: 'Amina Hassan', role: 'Hair Stylist', specialties: ['Braiding', 'Treatments'], branch: 'Nakuru CBD', chair: 'Room 1', phone: '+254712345603', commissionPct: 40, employmentStatus: 'active', accountEmail: '', accountStatus: 'pending', status: 'available' },
    { name: 'Grace Wanjiru', role: 'Nail Technician', specialties: ['Manicure', 'Pedicure'], branch: 'Nakuru CBD', chair: 'Station 1', phone: '+254712345604', commissionPct: 40, employmentStatus: 'active', accountEmail: '', accountStatus: 'pending', status: 'break' },
    { name: 'Faith Njeri', role: 'Spa Therapist', specialties: ['Massage', 'Facials'], branch: 'Nakuru CBD', chair: 'Room 2', phone: '+254712345605', commissionPct: 40, employmentStatus: 'active', accountEmail: '', accountStatus: 'pending', status: 'available' },
  ]);

  const [hcId, fadeId, beardId, comboId, kidsId, braidId, treatId, blowId, maniId, pediId, massageId, facialId] = await db.add('services', [
    { name: 'Regular Haircut', category: 'Barber', price: 500, currency: 'KES', durationMin: 30, description: 'Classic cut, wash and style.' },
    { name: 'Skin Fade', category: 'Barber', price: 700, currency: 'KES', durationMin: 40, description: 'Precision fade with clean lines.' },
    { name: 'Beard Trim & Shape', category: 'Barber', price: 300, currency: 'KES', durationMin: 20, description: 'Beard trim, edge-up and shape.' },
    { name: 'Haircut + Beard Combo', category: 'Barber', price: 900, currency: 'KES', durationMin: 50, description: 'Full haircut with beard grooming.' },
    { name: 'Kids Haircut', category: 'Barber', price: 400, currency: 'KES', durationMin: 25, description: 'Haircut for children under 12.' },
    { name: 'Box Braids (Medium)', category: 'Salon', price: 2500, currency: 'KES', durationMin: 120, description: 'Medium-size box braids.' },
    { name: 'Deep Hair Treatment', category: 'Salon', price: 1500, currency: 'KES', durationMin: 60, description: 'Reparative deep conditioning treatment.' },
    { name: 'Blow Dry & Style', category: 'Salon', price: 600, currency: 'KES', durationMin: 30, description: 'Wash, blow dry and style.' },
    { name: 'Classic Manicure', category: 'Nails', price: 800, currency: 'KES', durationMin: 40, description: 'Nail shaping, cuticle care and polish.' },
    { name: 'Gel Pedicure', category: 'Nails', price: 1200, currency: 'KES', durationMin: 50, description: 'Gel pedicure with foot massage.' },
    { name: 'Swedish Massage', category: 'Spa', price: 2500, currency: 'KES', durationMin: 60, description: 'Full body relaxation massage.' },
    { name: 'Facial Glow Treatment', category: 'Spa', price: 2000, currency: 'KES', durationMin: 45, description: 'Deep cleanse and hydrating facial.' },
  ]);

  await db.add('services', buildPriceListServices());

  const [pomadeId, beardOilId, treatCreamId, , polishId, oilId] = await db.add('products', [
    { name: 'Matte Pomade', category: 'Hair Care', price: 350, cost: 180, stock: 24, lowStockThreshold: 5, unit: 'pcs' },
    { name: 'Beard Oil', category: 'Grooming', price: 450, cost: 220, stock: 18, lowStockThreshold: 5, unit: 'pcs' },
    { name: 'Treatment Cream', category: 'Salon Supplies', price: 20, cost: 12, stock: 420, lowStockThreshold: 100, unit: 'ml' },
    { name: 'Professional Shampoo', category: 'Hair Care', price: 600, cost: 300, stock: 3, lowStockThreshold: 4, unit: 'bottle' },
    { name: 'Gel Nail Polish', category: 'Nail Supplies', price: 250, cost: 120, stock: 30, lowStockThreshold: 6, unit: 'pcs' },
    { name: 'Massage Oil', category: 'Spa Supplies', price: 50, cost: 25, stock: 1800, lowStockThreshold: 300, unit: 'ml' },
  ]);

  const [c1, c2, c3, c4, c5, c6] = await db.add('customers', [
    { name: 'James Kariuki', phone: '+254722100001', email: 'james.k@example.com', notes: 'Prefers Kevin, low fade every 3 weeks.', loyaltyPoints: 340, totalSpent: 12400, totalSpentUSD: 0, visits: 9, lastVisit: now - 3 * DAY, createdAt: now - 200 * DAY },
    { name: 'Mercy Chebet', phone: '+254722100002', email: 'mercy.c@example.com', notes: 'Allergic to certain nail polish brands.', loyaltyPoints: 180, totalSpent: 8600, totalSpentUSD: 0, visits: 6, lastVisit: now - 10 * DAY, createdAt: now - 150 * DAY },
    { name: 'Daniel Kiptoo', phone: '+254722100003', email: '', notes: '', loyaltyPoints: 60, totalSpent: 2700, totalSpentUSD: 0, visits: 3, lastVisit: now - 75 * DAY, createdAt: now - 120 * DAY },
    { name: 'Susan Achieng', phone: '+254722100004', email: 'susan.a@example.com', notes: 'VIP - monthly spa regular.', loyaltyPoints: 520, totalSpent: 21000, totalSpentUSD: 0, visits: 12, lastVisit: now - 2 * DAY, createdAt: now - 300 * DAY },
    { name: 'Peter Omondi', phone: '+254722100005', email: '', notes: 'New client, referred by James.', loyaltyPoints: 15, totalSpent: 900, totalSpentUSD: 0, visits: 1, lastVisit: now - 1 * DAY, createdAt: now - 2 * DAY },
    { name: 'Lilian Wambui', phone: '+254722100006', email: 'lilian.w@example.com', notes: 'Braiding every 6 weeks.', loyaltyPoints: 210, totalSpent: 9800, totalSpentUSD: 0, visits: 5, lastVisit: now - 65 * DAY, createdAt: now - 260 * DAY },
  ]);

  const todayStr = new Date(now).toISOString().slice(0, 10);
  const tomorrow = new Date(now + DAY).toISOString().slice(0, 10);

  await db.add('appointments', [
    { customerId: c1, customerName: 'James Kariuki', serviceId: fadeId, serviceName: 'Skin Fade', staffId: kevinId, staffName: 'Kevin Otieno', date: todayStr, time: '09:00', durationMin: 40, price: 700, currency: 'KES', status: 'completed' },
    { customerId: c4, customerName: 'Susan Achieng', serviceId: massageId, serviceName: 'Swedish Massage', staffId: faithId, staffName: 'Faith Njeri', date: todayStr, time: '10:30', durationMin: 60, price: 2500, currency: 'KES', status: 'in-service' },
    { customerId: c2, customerName: 'Mercy Chebet', serviceId: maniId, serviceName: 'Classic Manicure', staffId: graceId, staffName: 'Grace Wanjiru', date: todayStr, time: '11:15', durationMin: 40, price: 800, currency: 'KES', status: 'confirmed' },
    { customerId: c5, customerName: 'Peter Omondi', serviceId: hcId, serviceName: 'Regular Haircut', staffId: brianId, staffName: 'Brian Mwangi', date: todayStr, time: '14:00', durationMin: 30, price: 500, currency: 'KES', status: 'pending' },
    { customerId: c6, customerName: 'Lilian Wambui', serviceId: braidId, serviceName: 'Box Braids (Medium)', staffId: aminaId, staffName: 'Amina Hassan', date: tomorrow, time: '09:30', durationMin: 120, price: 2500, currency: 'KES', status: 'confirmed' },
  ]);

  await db.add('queue', [
    { customerName: 'Susan Achieng', serviceName: 'Swedish Massage', staffId: faithId, staffName: 'Faith Njeri', status: 'in-service', joinedAt: now - 30 * 60 * 1000, position: 1 },
    { customerName: 'Mercy Chebet', serviceName: 'Classic Manicure', staffId: graceId, staffName: 'Grace Wanjiru', status: 'waiting', joinedAt: now - 10 * 60 * 1000, position: 2 },
    { customerName: 'Walk-in - Tony', serviceName: 'Beard Trim & Shape', staffId: null, staffName: null, status: 'waiting', joinedAt: now - 3 * 60 * 1000, position: 3 },
  ]);

  const orderSeeds: any[] = [];
  const pushOrder = (daysAgo: number, hour: number, customerId: string, customerName: string, items: any[], discountPct = 0, paymentMethod = 'M-Pesa') => {
    const itemsWithCurrency = items.map((it: any) => ({ ...it, currency: it.currency || 'KES' }));
    const subtotalByCurrency: Record<string, number> = {};
    for (const it of itemsWithCurrency) subtotalByCurrency[it.currency] = (subtotalByCurrency[it.currency] || 0) + it.price * it.qty;
    const discountByCurrency: Record<string, number> = {};
    const totalByCurrency: Record<string, number> = {};
    for (const cur of Object.keys(subtotalByCurrency)) {
      const d = Math.round(subtotalByCurrency[cur] * (discountPct / 100));
      discountByCurrency[cur] = d;
      totalByCurrency[cur] = subtotalByCurrency[cur] - d;
    }

    const d = new Date(now - daysAgo * DAY);
    d.setHours(hour, Math.floor(Math.random() * 50), 0, 0);
    orderSeeds.push({ customerId, customerName, items: itemsWithCurrency, discountPct, subtotalByCurrency, discountByCurrency, totalByCurrency, paymentMethod, createdAt: d.getTime() });
  };

  pushOrder(0, 9, c1, 'James Kariuki', [{ type: 'service', refId: fadeId, name: 'Skin Fade', price: 700, qty: 1, staffId: kevinId, staffName: 'Kevin Otieno' }, { type: 'product', refId: beardOilId, name: 'Beard Oil', price: 450, qty: 1 }]);
  pushOrder(1, 15, c2, 'Mercy Chebet', [{ type: 'service', refId: pediId, name: 'Gel Pedicure', price: 1200, qty: 1, staffId: graceId, staffName: 'Grace Wanjiru' }]);
  pushOrder(2, 11, c4, 'Susan Achieng', [{ type: 'service', refId: facialId, name: 'Facial Glow Treatment', price: 2000, qty: 1, staffId: faithId, staffName: 'Faith Njeri' }, { type: 'product', refId: oilId, name: 'Massage Oil', price: 50, qty: 4 }]);
  pushOrder(3, 10, c3, 'Daniel Kiptoo', [{ type: 'service', refId: hcId, name: 'Regular Haircut', price: 500, qty: 1, staffId: brianId, staffName: 'Brian Mwangi' }]);
  pushOrder(4, 16, c6, 'Lilian Wambui', [{ type: 'service', refId: treatId, name: 'Deep Hair Treatment', price: 1500, qty: 1, staffId: aminaId, staffName: 'Amina Hassan' }, { type: 'product', refId: treatCreamId, name: 'Treatment Cream', price: 20, qty: 20 }], 10);
  pushOrder(5, 13, c1, 'James Kariuki', [{ type: 'service', refId: comboId, name: 'Haircut + Beard Combo', price: 900, qty: 1, staffId: kevinId, staffName: 'Kevin Otieno' }]);
  pushOrder(6, 9, c5, 'Peter Omondi', [{ type: 'service', refId: kidsId, name: 'Kids Haircut', price: 400, qty: 1, staffId: brianId, staffName: 'Brian Mwangi' }], 0, 'Cash');
  pushOrder(7, 12, c4, 'Susan Achieng', [{ type: 'service', refId: massageId, name: 'Swedish Massage', price: 2500, qty: 1, staffId: faithId, staffName: 'Faith Njeri' }]);
  pushOrder(9, 10, c2, 'Mercy Chebet', [{ type: 'service', refId: maniId, name: 'Classic Manicure', price: 800, qty: 1, staffId: graceId, staffName: 'Grace Wanjiru' }, { type: 'product', refId: polishId, name: 'Gel Nail Polish', price: 250, qty: 1 }]);
  pushOrder(11, 14, c1, 'James Kariuki', [{ type: 'service', refId: fadeId, name: 'Skin Fade', price: 700, qty: 1, staffId: kevinId, staffName: 'Kevin Otieno' }, { type: 'product', refId: pomadeId, name: 'Matte Pomade', price: 350, qty: 1 }]);
  pushOrder(13, 11, c6, 'Lilian Wambui', [{ type: 'service', refId: blowId, name: 'Blow Dry & Style', price: 600, qty: 1, staffId: aminaId, staffName: 'Amina Hassan' }], 0, 'Cash');
  pushOrder(15, 16, c3, 'Daniel Kiptoo', [{ type: 'service', refId: beardId, name: 'Beard Trim & Shape', price: 300, qty: 1, staffId: kevinId, staffName: 'Kevin Otieno' }]);
  pushOrder(18, 9, c4, 'Susan Achieng', [{ type: 'service', refId: facialId, name: 'Facial Glow Treatment', price: 2000, qty: 1, staffId: faithId, staffName: 'Faith Njeri' }]);
  pushOrder(20, 10, c2, 'Mercy Chebet', [{ type: 'service', refId: pediId, name: 'Gel Pedicure', price: 1200, qty: 1, staffId: graceId, staffName: 'Grace Wanjiru' }]);

  await db.add('orders', orderSeeds);

  await db.add('expenses', [
    { category: 'Rent', amount: 45000, note: 'Monthly shop rent - Nakuru CBD', date: new Date(now - 25 * DAY).toISOString().slice(0, 10) },
    { category: 'Utilities', amount: 6200, note: 'Electricity and water', date: new Date(now - 15 * DAY).toISOString().slice(0, 10) },
    { category: 'Supplies', amount: 8400, note: 'Restocked hair and nail supplies', date: new Date(now - 8 * DAY).toISOString().slice(0, 10) },
    { category: 'Marketing', amount: 3000, note: 'Social media promotion boost', date: new Date(now - 4 * DAY).toISOString().slice(0, 10) },
    { category: 'Salaries (base)', amount: 32000, note: 'Base pay top-up for support staff', date: new Date(now - 2 * DAY).toISOString().slice(0, 10) },
  ]);

  await db.add('messages', [
    { channel: 'team', senderName: 'Kevin Otieno', senderRole: 'barber', text: 'Morning team! Chair 1 is set up and ready.', createdAt: now - 3 * 3600 * 1000 },
    { channel: 'team', senderName: 'Front Desk (Receptionist)', senderRole: 'receptionist', text: 'Reminder: Susan Achieng is booked for a 60-min massage at 10:30, please have Room 2 ready.', createdAt: now - 2 * 3600 * 1000 },
    { channel: 'team', senderName: 'Faith Njeri', senderRole: 'barber', text: 'Got it, Room 2 is prepped.', createdAt: now - 90 * 60 * 1000 },
    { channel: 'management', senderName: 'Business Owner', senderRole: 'owner', text: 'Great numbers this week team, keep it up. Let us discuss the new promo idea for Tuesday afternoons.', createdAt: now - 5 * 3600 * 1000 },
    { channel: 'management', senderName: 'Front Desk (Receptionist)', senderRole: 'receptionist', text: 'Sounds good, I will draft the promo details and share by end of day.', createdAt: now - 4 * 3600 * 1000 },
  ]);
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],
  'GET /api/public/salons': [async () => {
    const { items } = await db.list('salons', { limit: 5000 });
    return json({ items: (items as any[]).filter(salon => salon.status === 'active').map(salon => ({ id: salon.id, name: salon.name })) });
  }],
  'GET /api/public/branches': [async ({ query }) => {
    const salonId = String(query.salonId || '');
    if (!salonId) return error('Salon is required', 400);
    const { items } = await db.list('branches', { limit: 5000 });
    return json({ items: (items as any[]).filter(branch => branch.salonId === salonId && branch.status === 'active') });
  }],
  'POST /api/auth/login': [async ({ body }) => {
    const identifier = String(body?.identifier || body?.email || '').trim();
    const credential = String(body?.credential || body?.password || '');
    if (!identifier || !credential) return error('Email or phone and a credential are required', 400);
    const { items } = await db.list('accounts', { limit: 5000 });
    const normalizedPhone = normalizeCustomerPhone(identifier);
    const account = (items as any[]).find(item => item.status === 'active'
      && (String(item.email || '').toLowerCase() === identifier.toLowerCase() || (normalizedPhone && normalizeCustomerPhone(item.phone) === normalizedPhone)));
    if (!account) return error('Invalid login details', 401);
    const role = normalizeRole(account.role);
    const usesPassword = Boolean(account.passwordHash) || role === 'admin' || role === 'owner';
    const validCredential = usesPassword ? passwordMatches(credential, account.passwordHash) : /^\d{4}$/.test(credential) && passwordMatches(credential, account.pinHash);
    if (!validCredential) return error('Invalid login details', 401);
    const token = sessionToken();
    await db.add('sessions', [sessionRecord(token, account)]);
    return json({ token, account: { id: account.id, name: account.name, email: account.email, role, salonId: account.tenantId, salonName: account.salonName, branchId: account.branchId, staffId: account.staffId || null, requiresPinChange: Boolean(account.staffId && role !== 'admin' && !account.pinChangedAt) } });
  }],
  'POST /api/auth/signup': [async ({ body }) => {
    const name = String(body?.name || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    const pin = String(body?.pin || '');
    const phone = String(body?.phone || '').trim();
    const salonId = String(body?.salonId || '').trim();
    const branchId = String(body?.branchId || '').trim();
    if (!name || !phone || !/^\d{4}$/.test(pin)) return error('Name, phone and a 4-digit PIN are required', 400);
    if (!salonId) return error('Choose a salon before creating a customer account', 400);
    if (!branchId) return error('Choose a branch before creating a customer account', 400);
    const accounts = await db.list('accounts', { limit: 5000 });
    if (email && (accounts.items as any[]).some(account => String(account.email || '').toLowerCase() === email)) return error('An account with that email already exists', 409);
    const [salon] = await db.get('salons', [salonId]);
    if (!salon) return error('Selected salon was not found', 404);
    const { items: branches } = await db.list('branches', { limit: 5000 });
    const branch = (branches as any[]).find(item => item.id === branchId && item.salonId === salonId && item.status === 'active');
    if (!branch) return error('Selected branch was not found in this salon', 400);
    const account = { id: `account-${randomBytes(8).toString('hex')}`, tenantId: salonId, salonName: salon.name, branchId, name, email, phone, role: 'customer', status: 'active', pinHash: passwordHash(pin), createdAt: Date.now() };
    await db.add('accounts', [account]);
    const customerId = `customer-${randomBytes(8).toString('hex')}`;
    await db.add('customers', [{ id: customerId, name, phone, email, notes: '', loyaltyPoints: 0, totalSpent: 0, totalSpentUSD: 0, visits: 0, lastVisit: null, createdAt: Date.now(), membershipTier: 'none', membershipExpiry: null }]);
    const token = sessionToken();
    await db.add('sessions', [sessionRecord(token, account)]);
    return json({ token, account: { id: account.id, name, email, role: account.role, salonId, salonName: account.salonName, branchId } });
  }],
  'POST /api/auth/demo': [async () => {
    await ensurePlatformAdmin();
    return json({ message: 'Platform administrator access ready', accounts: [{ email: PLATFORM_ADMIN_EMAIL, password: PLATFORM_ADMIN_PASSWORD, role: 'admin' }] });
  }],
  'GET /api/admin/directory': [async () => {
    requireAdmin();
    const [salons, branches, accounts] = await Promise.all([db.list('salons', { limit: 5000 }), db.list('branches', { limit: 5000 }), db.list('accounts', { limit: 5000 })]);
    return json({ salons: salons.items, branches: branches.items, accounts: (accounts.items as any[]).map(account => ({ ...account, passwordHash: undefined })) });
  }],
  'GET /api/branches': [async () => {
    const context = currentContext();
    if (!context?.tenantId) return error('Salon context is required', 400);
    const { items } = await db.list('branches', { limit: 5000 });
    return json({ items: (items as any[]).filter(branch => (context.role === 'admin' || branch.salonId === context.tenantId) && branch.status === 'active') });
  }],
  'POST /api/branches': [async ({ body }) => {
    const context = currentContext();
    if (!context || !['owner', 'admin'].includes(context.role)) return error('Only the owner or administrator can add branches', 403);
    const name = String(body?.name || '').trim();
    if (!name) return error('Branch name is required', 400);
    const salonId = context!.role === 'admin' ? String(body?.salonId || '') : context!.tenantId;
    const [salon] = await db.get('salons', [salonId]);
    if (!salon) return error('Choose a valid salon', 400);
    const branchId = `${salonId}-${randomBytes(6).toString('hex')}`;
    await db.add('branches', [{ id: branchId, salonId, name, address: body?.address || '', status: 'active', createdAt: Date.now() }]);
    return json({ branchId, name });
  }],
  'POST /api/admin/salons': [async ({ body }) => {
    requireAdmin();
    const name = String(body?.name || '').trim();
    const ownerName = String(body?.ownerName || '').trim();
    const ownerEmail = String(body?.ownerEmail || '').trim().toLowerCase();
    const ownerPassword = String(body?.ownerPassword || '');
    if (!name || !ownerName || !ownerEmail || ownerPassword.length < 8) return error('Salon, owner name, owner email and an 8-character password are required', 400);
    const salonId = `salon-${randomBytes(8).toString('hex')}`;
    const branchId = `${salonId}-main`;
    const accountId = `account-${randomBytes(8).toString('hex')}`;
    await db.add('salons', [{ id: salonId, name, status: 'active', createdAt: Date.now() }]);
    await db.add('branches', [{ id: branchId, salonId, name: body.branchName || 'Main Branch', status: 'active', createdAt: Date.now() }]);
    await db.add('accounts', [{ id: accountId, tenantId: salonId, salonName: name, branchId, name: ownerName, email: ownerEmail, phone: body.ownerPhone || '', role: 'owner', status: 'active', passwordHash: passwordHash(ownerPassword), createdAt: Date.now() }]);
    await notifyCustomer(ownerEmail, `Your BRAIDY SALON owner account for ${name}`, `Salon: ${name}\nLogin email: ${ownerEmail}\nTemporary password: ${ownerPassword}\nPlease change the password after signing in.`, accountId);
    return json({ salonId, branchId, accountId, ownerEmail });
  }],
  'POST /api/admin/branches': [async ({ body }) => {
    requireAdmin();
    const salonId = String(body?.salonId || '');
    const [salon] = await db.get('salons', [salonId]);
    if (!salon) return error('Salon not found', 404);
    const branchId = `${salonId}-${randomBytes(6).toString('hex')}`;
    await db.add('branches', [{ id: branchId, salonId, name: String(body?.name || 'New Branch'), address: body?.address || '', status: 'active', createdAt: Date.now() }]);
    return json({ branchId, salonName: salon.name });
  }],
  'POST /api/admin/accounts/:id/reset-password': [async ({ params, body }) => {
    requireAdmin();
    const [account] = await db.get('accounts', [params.id]);
    const newPassword = String(body?.newPassword || '');
    if (!account) return error('Account not found', 404);
    if (newPassword.length < 8) return error('Password must be at least 8 characters', 400);
    await db.update('accounts', [{ id: account.id, record: { ...account, passwordHash: passwordHash(newPassword), passwordResetAt: Date.now() } }]);
    await notifyCustomer(account.email, 'Your BRAIDY SALON password was reset', `Your password was reset by the platform administrator.\nLogin email: ${account.email}\nNew temporary password: ${newPassword}`, account.id);
    return json({ ok: true, email: account.email });
  }],
  'POST /api/staff/me/pin': [async ({ body }) => {
    const context = currentContext();
    if (!context?.staffId || !['barber', 'receptionist'].includes(context.role)) return error('Only an employee can change this PIN', 403);
    const pin = String(body?.pin || '');
    if (!/^\d{4}$/.test(pin)) return error('PIN must be exactly 4 digits', 400);
    const [account] = await db.get('accounts', [context.accountId]);
    if (!account) return error('Employee account not found', 404);
    await db.update('accounts', [{ id: account.id, record: { ...account, pinHash: passwordHash(pin), pinChangedAt: Date.now() } }]);
    return json({ ok: true });
  }],
  'GET /api/attendance/me': [async () => {
    const context = currentContext();
    if (!context || !ATTENDANCE_ROLES.includes(context.role)) return error('Attendance is only available to salon staff and administrators', 403);
    const [branch] = context.branchId ? await db.get('branches', [context.branchId]) : [null];
    const date = nairobiDateString();
    const [item] = await db.get('attendance', [attendanceRecordId(context.accountId, date)]);
    const policy = attendancePolicy(branch?.name);
    let clients: any[] = [];
    if (context.staffId && item?.checkInAt && !item.checkOutAt) {
      const { items: appointments } = await db.list('appointments', { limit: 3000 });
      clients = (appointments as any[])
        .filter(appointment => !appointment.deletedAt && appointment.date === date && !['cancelled', 'no-show'].includes(appointment.status)
          && [appointment.staffId, ...(Array.isArray(appointment.items) ? appointment.items.map((service: any) => service.staffId) : [])].some(staffId => String(staffId || '') === String(context.staffId)))
        .map(appointment => ({ id: appointment.id, customerName: appointment.customerName, serviceName: appointment.serviceName, time: appointment.time }));
    }
    return json({ item: item || null, date, clients, attendanceLocation: { name: policy.name, radiusMeters: policy.radiusMeters } });
  }],
  'POST /api/attendance/check-in': [async ({ body }) => {
    const context = currentContext();
    if (!context || !ATTENDANCE_ROLES.includes(context.role)) return error('Attendance is only available to salon staff and administrators', 403);
    const [branch] = context.branchId ? await db.get('branches', [context.branchId]) : [null];
    let distanceMeters: number | null = null;
    if (context.role !== 'owner') {
      const location = verifiedAttendanceLocation(body, branch?.name);
      if (!location.ok) return error(location.error, 403);
      distanceMeters = location.distanceMeters;
    }
    const date = nairobiDateString();
    const id = attendanceRecordId(context.accountId, date);
    const [existing] = await db.get('attendance', [id]);
    if (existing) return error('You have already checked in today', 409);
    const item = {
      id, accountId: context.accountId, staffId: context.staffId || null, name: context.name,
      role: context.role, tenantId: context.tenantId, branchId: context.branchId || null,
      branchName: branch?.name || context.salonName, date, checkInAt: Date.now(), checkOutAt: null,
      verifiedDistanceMeters: distanceMeters,
    };
    try {
      await db.add('attendance', [item]);
    } catch {
      return error('You have already checked in today', 409);
    }
    return json({ item });
  }],
  'POST /api/attendance/check-out': [async ({ body }) => {
    const context = currentContext();
    if (!context || !ATTENDANCE_ROLES.includes(context.role)) return error('Attendance is only available to salon staff and administrators', 403);
    const [branch] = context.branchId ? await db.get('branches', [context.branchId]) : [null];
    let distanceMeters: number | null = null;
    if (context.role !== 'owner') {
      const location = verifiedAttendanceLocation(body, branch?.name);
      if (!location.ok) return error(location.error, 403);
      distanceMeters = location.distanceMeters;
    }
    const date = nairobiDateString();
    const id = attendanceRecordId(context.accountId, date);
    const [existing] = await db.get('attendance', [id]);
    if (!existing) return error('Check in before checking out', 409);
    if (existing.checkOutAt) return error('You have already checked out today', 409);
    const item = { ...existing, checkOutAt: Date.now(), checkOutDistanceMeters: distanceMeters };
    await db.update('attendance', [{ id, record: item }]);
    return json({ item });
  }],
  'GET /api/attendance': [async ({ query }) => {
    const context = currentContext();
    if (!context || !['owner', 'admin', 'receptionist'].includes(context.role)) return error('Only the owner, administrator or receptionist can view daily attendance', 403);
    const date = String(query.date || nairobiDateString());
    if (!nairobiDayRange(date)) return error('Choose a valid attendance date', 400);
    const { items } = await db.list('attendance', { limit: 5000 });
    const visible = (items as any[]).filter(item => item.date === date && (context.role !== 'receptionist' || item.role !== 'owner') && (!context.branchId || item.branchId === context.branchId));
    visible.sort((first, second) => Number(first.checkInAt || 0) - Number(second.checkInAt || 0));
    const activeAttendanceByStaffId = new Map(visible
      .filter(item => item.staffId && item.checkInAt && !item.checkOutAt)
      .map(item => [String(item.staffId), item]));
    const { items: appointments } = await db.list('appointments', { limit: 3000 });
    const clientAssignments = new Map<string, any[]>();
    for (const appointment of appointments as any[]) {
      if (appointment.deletedAt || appointment.date !== date || ['cancelled', 'no-show'].includes(appointment.status)
        || (context.branchId && appointment.branchId && appointment.branchId !== context.branchId)) continue;
      const staffIds = new Set([appointment.staffId, ...(Array.isArray(appointment.items) ? appointment.items.map((service: any) => service.staffId) : [])].filter(Boolean).map(String));
      for (const staffId of staffIds) {
        if (!activeAttendanceByStaffId.has(staffId)) continue;
        const assigned = clientAssignments.get(staffId) || [];
        assigned.push({ id: appointment.id, customerName: appointment.customerName, serviceName: appointment.serviceName, time: appointment.time });
        clientAssignments.set(staffId, assigned);
      }
    }
    return json({ items: visible.map(item => ({ ...item, clients: item.staffId ? clientAssignments.get(String(item.staffId)) || [] : [] })), date });
  }],
  'GET /api/queue': [async () => {
    const context = currentContext();
    const { items } = await db.list('queue', { limit: 5000 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt && (context?.role === 'admin' || !context?.branchId || !item.branchId || item.branchId === context.branchId)) });
  }],
  'POST /api/queue': [async ({ body }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const id = `queue-${randomBytes(8).toString('hex')}`;
    const item = { id, tenantId: context.tenantId, branchId: context.branchId || '', customerId: body?.customerId || null, customerName: String(body?.customerName || 'Customer'), serviceName: String(body?.serviceName || 'Service'), status: 'waiting', joinedAt: Date.now(), createdAt: Date.now() };
    await db.add('queue', [item]);
    return json({ item });
  }],
  'PUT /api/queue/:id': [async ({ params, body }) => {
    const [existing] = await db.get('queue', [params.id]);
    if (!existing) return error('Queue entry not found', 404);
    const updated = { ...existing, status: body?.status || existing.status, updatedAt: Date.now() };
    await db.update('queue', [{ id: params.id, record: updated }]);
    return json({ item: updated });
  }],
  'GET /api/orders': [async () => {
    const context = currentContext();
    const { items } = await db.list('orders', { limit: 10000 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt && (context?.role === 'admin' || !context?.branchId || !item.branchId || item.branchId === context.branchId)) });
  }],
  'GET /api/expenses': [async () => {
    const context = currentContext();
    const { items } = await db.list('expenses', { limit: 5000 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt && (context?.role === 'admin' || !context?.branchId || !item.branchId || item.branchId === context.branchId)) });
  }],
  'POST /api/expenses': [async ({ body }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const description = String(body?.description || '').trim();
    const amount = Number(body?.amount || 0);
    if (!description || !Number.isFinite(amount) || amount <= 0) return error('Description and a positive amount are required', 400);
    const id = `expense-${randomBytes(8).toString('hex')}`;
    const item = { id, tenantId: context.tenantId, branchId: context.branchId || '', description, category: body?.category || 'General', amount, date: body?.date || nairobiDateString(), createdAt: Date.now() };
    await db.add('expenses', [item]);
    return json({ item });
  }],
  'GET /api/payouts': [async () => {
    const context = currentContext();
    const { items } = await db.list('payouts', { limit: 5000 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt && (context?.role === 'admin' || !context?.branchId || !item.branchId || item.branchId === context.branchId)) });
  }],
  'GET /api/pos-drafts': [async ({ query }) => {
    const context = currentContext();
    const appointmentId = String(query.appointmentId || '').trim();
    const { items } = await db.list('pos_drafts', { limit: 5000 });
    const item = (items as any[]).find(draft => !draft.deletedAt && (!appointmentId || String(draft.appointmentId || '') === appointmentId) && (context?.role === 'admin' || !context?.branchId || !draft.branchId || draft.branchId === context.branchId));
    return json({ item: item || null });
  }],
  'POST /api/pos-drafts': [async ({ body }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const appointmentId = String(body?.appointmentId || '').trim();
    const { items } = await db.list('pos_drafts', { limit: 5000 });
    const existing = (items as any[]).find(draft => !draft.deletedAt && String(draft.appointmentId || '') === appointmentId);
    const item = { ...(existing || {}), id: existing?.id || `draft-${randomBytes(8).toString('hex')}`, tenantId: context.tenantId, branchId: context.branchId || '', appointmentId, cart: Array.isArray(body?.cart) ? body.cart : [], customerId: body?.customerId || null, discountPct: body?.discountPct || 0, promoCode: body?.promoCode || '', redeemPoints: body?.redeemPoints || 0, paymentMethod: body?.paymentMethod || 'Cash', updatedAt: Date.now(), createdAt: existing?.createdAt || Date.now() };
    if (existing) await db.update('pos_drafts', [{ id: existing.id, record: item }]); else await db.add('pos_drafts', [item]);
    return json({ item });
  }],
  'DELETE /api/pos-drafts': [async ({ query }) => {
    const appointmentId = String(query.appointmentId || '').trim();
    const { items } = await db.list('pos_drafts', { limit: 5000 });
    const matches = (items as any[]).filter(draft => !draft.deletedAt && (!appointmentId || String(draft.appointmentId || '') === appointmentId));
    for (const draft of matches) await db.update('pos_drafts', [{ id: draft.id, record: { ...draft, deletedAt: Date.now() } }]);
    return json({ ok: true });
  }],
  'GET /api/payroll/staff': [async ({ query }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const [{ items: staff }, { items: appointments }] = await Promise.all([db.list('staff', { limit: 5000 }), db.list('appointments', { limit: 10000 })]);
    const period = String(query.period || 'current');
    const range = period === 'last-week' ? mostRecentSaturdayThroughFridayRange(new Date(Date.now() - 7 * DAY)) : mostRecentSaturdayThroughFridayRange();
    const items = (staff as any[]).filter(member => !member.deletedAt && (context.role === 'admin' || member.tenantId === context.tenantId) && (!context.branchId || !member.branchId || member.branchId === context.branchId)).map(member => ({ ...member, commissionEarnedWeek: 0, assistantEarnedWeek: 0 }));
    return json({ items, period: { from: range.from, to: range.to } });
  }],
  'GET /api/analytics/rebooking': [async () => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const { items: appointments } = await db.list('appointments', { limit: 10000 });
    const items = (appointments as any[]).filter(item => !item.deletedAt && item.status === 'completed' && (context.role === 'admin' || !context.branchId || !item.branchId || item.branchId === context.branchId)).map(item => ({ id: item.id, customerId: item.customerId || null, customerName: item.customerName || 'Customer', lastAppointmentDate: item.date, lastServiceName: item.serviceName || 'Service', daysSinceCompleted: Math.max(0, Math.floor((Date.now() - new Date(`${item.date}T00:00:00+03:00`).getTime()) / DAY)), isRebooked: false })).slice(0, 500);
    return json({ items });
  }],

  'POST /api/earnings/delete': [async ({ body }) => {
    const context = currentContext();
    if (!context || !['owner', 'admin'].includes(context.role)) return error('Only the owner or administrator can delete staff earnings', 403);
    const from = Number(body?.from);
    const to = Number(body?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) return error('Choose a valid earnings date range', 400);
    const [{ items: orders }, { items: payoutItems }] = await Promise.all([
      db.list('orders', { limit: 5000 }),
      db.list('payout_items', { limit: 10000 }),
    ]);
    const orderDates = new Map((orders as any[]).filter(order => !order.deletedAt && Number(order.createdAt) >= from && Number(order.createdAt) < to).map(order => [String(order.id), Number(order.createdAt)]));
    const now = Date.now();
    const matching = (payoutItems as any[]).filter(item => !item.deletedAt && orderDates.has(String(item.orderId)));
    if (!matching.length) return error('No paid staff earnings were found in that date range', 404);
    await db.update('payout_items', matching.map(item => ({ id: item.id, record: { ...item, deletedAt: now, deletedBy: context.name, deletionReason: 'Owner cleared paid staff earnings' } })));
    const totalKES = matching.filter(item => item.currency === 'KES').reduce((sum, item) => sum + Number(item.commission || 0), 0);
    await audit('deleted paid staff earnings', 'payout_items', { from, to, itemCount: matching.length, totalKES }, context.name);
    return json({ deleted: matching.length, totalKES, from, to });
  }],
  'POST /api/payouts': [async () => {
    requireOwner();
    return error('Internal paid markers are disabled. Earnings are marked paid only after a verified payment transfer.', 410);
  }],
  'POST /api/payroll/send': [async ({ body }) => {
    const context = currentContext();
    if (!context || !['owner', 'admin'].includes(context.role)) return error('Only the owner or administrator can send payroll', 403);
    const recipients = Array.isArray(body?.recipients) ? body.recipients : [];
    if (!recipients.length) return error('Add at least one employee to payroll', 400);
    const initiator = process.env.MPESA_B2C_INITIATOR_NAME;
    const securityCredential = process.env.MPESA_B2C_SECURITY_CREDENTIAL;
    const shortcode = process.env.MPESA_B2C_SHORTCODE;
    const timeoutUrl = process.env.MPESA_B2C_QUEUE_TIMEOUT_URL;
    const resultUrl = process.env.MPESA_B2C_RESULT_URL;
    if (!initiator || !securityCredential || !shortcode || !timeoutUrl || !resultUrl) return error('M-Pesa B2C payroll is not configured. Add the B2C credentials and callback URLs to the backend environment.', 503);
    const cleanRecipients = recipients.map((recipient: any) => ({ staffId: String(recipient.staffId || ''), amountKES: Math.round(Number(recipient.amountKES) || 0), phone: String(recipient.phone || '').replace(/\s+/g, '').replace(/^\+/, '').replace(/^0/, '254') })).filter((recipient: any) => recipient.staffId && recipient.amountKES > 0 && /^254[71]\d{8}$/.test(recipient.phone));
    if (cleanRecipients.length !== recipients.length) return error('Every payroll recipient needs a valid Kenyan phone number and amount.', 400);
    const now = Date.now();
    const [batchId] = await db.add('payroll_batches', [{ status: 'submitting', totalKES: cleanRecipients.reduce((sum: number, recipient: any) => sum + recipient.amountKES, 0), employeeCount: cleanRecipients.length, createdAt: now }]);
    const baseUrl = process.env.MPESA_ENVIRONMENT === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
    try {
      const tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64')}` } });
      const tokenBody: any = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(tokenBody.errorMessage || 'Could not authenticate with Safaricom');
      const results: any[] = [];
      for (const recipient of cleanRecipients) {
        const response = await fetch(`${baseUrl}/mpesa/b2c/v1/paymentrequest`, { method: 'POST', headers: { Authorization: `Bearer ${tokenBody.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ InitiatorName: initiator, SecurityCredential: securityCredential, CommandID: process.env.MPESA_B2C_COMMAND_ID || 'BusinessPayment', Amount: recipient.amountKES, PartyA: shortcode, PartyB: recipient.phone, Remarks: `BRAIDY SALON payroll ${batchId}`, QueueTimeOutURL: timeoutUrl, ResultURL: resultUrl, Occasion: 'Payroll' }) });
        const bodyResult: any = await response.json();
        const [itemId] = await db.add('payroll_items', [{ batchId, ...recipient, status: response.ok ? 'submitted' : 'failed', conversationId: bodyResult.ConversationID || null, response: bodyResult, createdAt: now }]);
        results.push({ id: itemId, staffId: recipient.staffId, status: response.ok ? 'submitted' : 'failed', response: bodyResult });
      }
      const failedCount = results.filter(result => result.status === 'failed').length;
      await db.update('payroll_batches', [{ id: batchId, record: { id: batchId, status: failedCount ? 'partial' : 'submitted', totalKES: cleanRecipients.reduce((sum: number, recipient: any) => sum + recipient.amountKES, 0), employeeCount: cleanRecipients.length, sentCount: results.length - failedCount, failedCount, createdAt: now } }]);
      await audit('submitted', 'payroll_batch', { id: batchId, employeeCount: cleanRecipients.length, failedCount }, 'owner');
      return json({ id: batchId, totalKES: cleanRecipients.reduce((sum: number, recipient: any) => sum + recipient.amountKES, 0), employeeCount: cleanRecipients.length, sentCount: results.length - failedCount, failedCount, status: failedCount ? 'failed' : 'submitted' });
    } catch (cause) {
      await db.update('payroll_batches', [{ id: batchId, record: { id: batchId, status: 'failed', totalKES: cleanRecipients.reduce((sum: number, recipient: any) => sum + recipient.amountKES, 0), employeeCount: cleanRecipients.length, failedCount: cleanRecipients.length, createdAt: now, error: cause instanceof Error ? cause.message : 'Payroll failed' } }]);
      return error(cause instanceof Error ? cause.message : 'Payroll transfer failed', 502);
    }
  }],
  'POST /api/payroll/result': [async ({ body }) => { await db.add('payroll_callbacks', [{ type: 'result', body, createdAt: Date.now() }]); return json({ ResultCode: 0, ResultDesc: 'Accepted' }); }],
  'POST /api/payroll/timeout': [async ({ body }) => { await db.add('payroll_callbacks', [{ type: 'timeout', body, createdAt: Date.now() }]); return json({ ResultCode: 0, ResultDesc: 'Accepted' }); }],

  'GET /api/payroll/paystack/status': [async () => {
    const context = currentContext();
    if (!context || !['owner', 'admin'].includes(context.role)) return error('Only the owner or administrator can configure payroll transfers', 403);
    const multiplier = Number(process.env.PAYSTACK_TRANSFER_AMOUNT_MULTIPLIER || 100);
    const validMultiplier = Number.isSafeInteger(multiplier) && multiplier > 0;
    const secretKey = String(process.env.PAYSTACK_SECRET_KEY || '');
    return json({ configured: secretKey.startsWith('sk_live_') && validMultiplier, canSend: context.role === 'owner', currency: 'KES', amountMultiplier: validMultiplier ? multiplier : null, webhookPath: '/api/paystack/webhook' });
  }],
  'GET /api/payroll/paystack/batches': [async () => {
    const context = currentContext();
    if (!context || !['owner', 'admin'].includes(context.role)) return error('Only the owner or administrator can view Paystack payroll history', 403);
    const [{ items: batches }, { items: payrollItems }] = await Promise.all([db.list('payroll_batches', { limit: 500 }), db.list('payroll_items', { limit: 5000 })]);
    const visibleBatches = (batches as any[]).filter(batch => batch.provider === 'paystack' && batch.tenantId === context.tenantId && (!context.branchId || batch.branchId === context.branchId));
    visibleBatches.sort((first, second) => Number(second.createdAt || 0) - Number(first.createdAt || 0));
    return json({ items: visibleBatches.slice(0, 20).map(batch => ({
      id: batch.id, status: batch.status, totalKES: batch.totalKES, employeeCount: batch.employeeCount,
      sentCount: batch.sentCount || 0, failedCount: batch.failedCount || 0, createdAt: batch.createdAt,
      transfers: (payrollItems as any[]).filter(item => item.provider === 'paystack' && item.batchId === batch.id && item.tenantId === context.tenantId)
        .map(item => ({ staffId: item.staffId, staffName: item.staffName, amountKES: item.amountKES, status: item.status, reference: item.reference, failureReason: item.failureReason || item.error || item.webhookIssue || '' })),
    })) });
  }],
  'POST /api/payroll/paystack/recipients/sync': [async () => {
    const context = currentContext();
    if (!context || context.role !== 'owner') return error('Only the salon owner can sync Paystack recipients', 403);
    if (!String(process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_live_')) return error('Recipient setup requires a live PAYSTACK_SECRET_KEY in the backend environment.', 503);
    const [{ items: staffRows }, { items: accounts }] = await Promise.all([
      db.list('staff', { limit: 5000 }), db.list('accounts', { limit: 5000 }),
    ]);
    const accountByStaffId = new Map((accounts as any[]).filter(account => account.staffId).map(account => [String(account.staffId), account]));
    const members = (staffRows as any[]).filter(member => member.tenantId === context.tenantId
      && isPaystackRecipientEligible(member, accountByStaffId.get(String(member.id))?.role));
    let createdCount = 0;
    let existingCount = 0;
    let recipientResult: Awaited<ReturnType<typeof createPaystackStaffRecipients>>;
    try { recipientResult = await createPaystackStaffRecipients(members); }
    catch (cause) { return error(cause instanceof Error ? cause.message : 'Paystack recipient setup failed.', 502); }
    const failureByStaffId = new Map<string, string>(recipientResult.failures.map(failure => [String(failure.member.id), failure.error]));
    const failures: { name: string; error: string }[] = [];
    const updates: any[] = [];
    for (const member of members) {
      const paystackRecipientCode = recipientResult.recipientCodesByPhone.get(normalizeCustomerPhone(member.phone));
      if (!paystackRecipientCode) {
        failures.push({ name: String(member.name || 'Unknown staff member'), error: failureByStaffId.get(String(member.id)) || 'Paystack did not return a valid recipient code.' });
        continue;
      }
      if (member.paystackRecipientMode === 'live' && member.paystackRecipientCode === paystackRecipientCode) existingCount += 1;
      else createdCount += 1;
      updates.push({ id: member.id, record: { ...member, paystackRecipientCode, paystackRecipientMode: 'live' } });
    }
    if (updates.length) await db.update('staff', updates);
    return json({ eligibleCount: members.length, createdCount, existingCount, failedCount: failures.length, failures });
  }],
  'POST /api/payroll/paystack/send': [async ({ body }) => {
    const context = currentContext();
    if (!context || context.role !== 'owner') return error('Only the salon owner can send Paystack payroll', 403);
    if (!String(process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_live_')) return error('Paystack payroll requires a live PAYSTACK_SECRET_KEY in the backend environment.', 503);
    const multiplier = Number(process.env.PAYSTACK_TRANSFER_AMOUNT_MULTIPLIER || 100);
    if (!Number.isSafeInteger(multiplier) || multiplier <= 0) return error('PAYSTACK_TRANSFER_AMOUNT_MULTIPLIER must be a positive integer.', 503);
    const requestedIds = Array.isArray(body?.staffIds) ? Array.from(new Set(body.staffIds.map((id: unknown) => String(id || '').trim()).filter(Boolean))) : [];
    if (!requestedIds.length) return error('Select at least one staff member for payroll.', 400);
    if (requestedIds.length > 100) return error('Paystack bulk transfers support up to 100 recipients per batch.', 400);

    const [{ items: staffRows }, { items: orders }, { items: payoutItems }, { items: appointments }, { items: payrollItems }] = await Promise.all([
      db.list('staff', { limit: 2000 }), db.list('orders', { limit: 5000 }), db.list('payout_items', { limit: 10000 }),
      db.list('appointments', { limit: 5000 }), db.list('payroll_items', { limit: 5000 }),
    ]);
    const members = (staffRows as any[]).filter(member => !member.deletedAt && member.employmentStatus !== 'laid-off' && contextIncludesPayrollRecord(member, context)
      && (!context.branchId || member.branchId === context.branchId) && requestedIds.includes(String(member.id)));
    if (!members.length) return error('No active staff records are available for this payroll batch.', 400);
    if (members.length !== requestedIds.length) return error('One or more selected staff members are not available in this salon or branch.', 400);

    const staffById = new Map(members.map(member => [String(member.id), member]));
    const earningsByStaffId = new Map<string, any[]>();
    const lockedItemKeys = new Set<string>();
    const tenantAppointments = (appointments as any[]).filter(item => contextIncludesPayrollRecord(item, context));
    const scopedBranchOrders = branchScopedPayrollOrders(orders as any[], tenantAppointments, staffById, context);
    const branchPayoutItems = branchScopedPayrollPayoutItems(payoutItems as any[], context);
    const { from, to } = currentSaturdayThroughFridayRange();
    const earnings = calculateUnpaidStaffEarnings(scopedBranchOrders, branchPayoutItems, tenantAppointments, from, to, payrollItems as any[])
      .filter(line => staffById.has(line.staffId) && line.currency === 'KES');
    for (const earning of earnings) {
      const lines = earningsByStaffId.get(earning.staffId) || [];
      lines.push(earning);
      earningsByStaffId.set(earning.staffId, lines);
    }
    const pendingStatuses = new Set(['submitting', 'pending', 'unknown', 'review']);
    for (const item of previousPayrollItems as any[]) {
      if (item.provider !== 'paystack' || !pendingStatuses.has(item.status)) continue;
      for (const itemKey of Array.isArray(item.itemKeys) ? item.itemKeys : []) lockedItemKeys.add(String(itemKey));
    }
    const transfers: any[] = [];
    for (const member of members) {
      const lines = earningsByStaffId.get(String(member.id)) || [];
      const amountKES = Math.round(lines.reduce((sum, line) => sum + Number(line.amount || 0), 0));
      if (!lines.length || amountKES <= 0) continue;
      if (lines.some(line => lockedItemKeys.has(String(line.itemKey)))) return error(`A transfer for ${member.name}'s payroll is already pending. Check transfer status before retrying.`, 409);
      const expectedAmountKES = Number(body?.expectedAmountsKES?.[member.id]);
      if (!Number.isSafeInteger(expectedAmountKES) || expectedAmountKES !== amountKES) return error(`Unpaid earnings changed for ${member.name}. Refresh payroll and confirm the updated total.`, 409);
      const amount = toPaystackMinorAmount(amountKES, multiplier);
      if (!amount) return error(`Could not calculate a valid payment amount for ${member.name}.`, 400);
      transfers.push({ member, lines, amountKES, amount, reference: randomBytes(16).toString('hex') });
    }
    if (!transfers.length) return error('No active staff have non-zero unpaid KES earnings for this payroll period.', 409);
    const missingRecipient = transfers.find(({ member }) => member.paystackRecipientMode !== 'live'
      || !/^RCP_[A-Za-z0-9]+$/.test(String(member.paystackRecipientCode || '')));
    if (missingRecipient) return error(`Sync Paystack recipients before sending. ${missingRecipient.member.name} does not have a live recipient code.`, 409);
    if (new Set(transfers.map(transfer => transfer.member.paystackRecipientCode)).size !== transfers.length) return error('Each staff member must have a unique Paystack recipient code.', 400);
    const invalidTransfer = transfers.find(transfer => {
      const { member, amountKES, amount, reference } = transfer;
      const phone = normalizeCustomerPhone(member.phone);
      return !Number.isSafeInteger(amountKES) || amountKES <= 0
        || !Number.isSafeInteger(amount) || amount <= 0
        || !/^254[71]\d{8}$/.test(phone)
        || member.paystackRecipientMode !== 'live'
        || !/^RCP_[A-Za-z0-9]+$/.test(String(member.paystackRecipientCode || ''))
        || !/^[a-z0-9_-]{16,50}$/.test(String(reference || ''));
    });
    if (invalidTransfer) return error(`Payroll entry for ${invalidTransfer.member.name} failed local Paystack validation. Sync recipients and refresh payroll; no payment was sent.`, 400);
    const paystackTransfers = transfers.map(transfer => ({
      amount: transfer.amount,
      recipient: String(transfer.member.paystackRecipientCode),
      reference: transfer.reference,
      reason: `BRAIDY SALON payroll ${randomBytes(8).toString('hex')}`,
    }));

    const totalKES = transfers.reduce((sum, transfer) => sum + transfer.amountKES, 0);
    let balanceBody: any;
    try {
      const balanceResponse = await fetch('https://api.paystack.co/balance', {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
        signal: AbortSignal.timeout(10000),
      });
      balanceBody = await balanceResponse.json().catch(() => ({}));
      if (!balanceResponse.ok || !balanceBody.status) return error('Could not verify Paystack KES balance. No payroll was submitted.', 502);
    } catch {
      return error('Could not verify Paystack KES balance. No payroll was submitted.', 502);
    }
    const balances = Array.isArray(balanceBody.data) ? balanceBody.data : [balanceBody.data];
    const availableBalanceMinor = Number(balances.find((balance: any) => String(balance?.currency || '').toUpperCase() === 'KES')?.balance);
    if (!hasSufficientPaystackPrincipalBalance(availableBalanceMinor, paystackTransfers.map(transfer => transfer.amount))) {
      return error(`Insufficient Paystack KES balance for the KES ${totalKES.toLocaleString('en-KE')} payroll principal, before transfer fees. Add funds and refresh payroll; no transfer was submitted.`, 409);
    }

    const now = Date.now();
    const [batchId] = await db.add('payroll_batches', [{ tenantId: context.tenantId, branchId: context.branchId || null, provider: 'paystack', status: 'submitting', totalKES, employeeCount: transfers.length, createdAt: now }]);
    const payrollRecords = transfers.map(transfer => ({
      tenantId: context.tenantId, branchId: context.branchId || transfer.member.branchId || null, provider: 'paystack', batchId,
      staffId: transfer.member.id, staffName: transfer.member.name, recipientCode: transfer.member.paystackRecipientCode,
      amountKES: transfer.amountKES, amount: transfer.amount, currency: 'KES', reference: transfer.reference,
      itemKeys: transfer.lines.map((line: any) => String(line.itemKey)), earningLines: transfer.lines,
      status: 'submitting', createdAt: now,
    }));
    const itemIds = await db.add('payroll_items', payrollRecords);
    try {
      const response = await fetch('https://api.paystack.co/transfer/bulk', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'balance', currency: 'KES', transfers: paystackTransfers }),
      });
      const resultBody: any = await response.json().catch(() => ({}));
      if (!response.ok || !resultBody.status) {
        const providerMessage = String(resultBody.message || `Paystack rejected the batch (${response.status}).`);
        const thirdPartyPayoutsDisabled = /cannot initiate third[ -]party payouts/i.test(providerMessage);
        const providerErrors = Array.isArray(resultBody.data?.errors) ? resultBody.data.errors : [];
        const providerErrorDetails = providerErrors.map((item: any) => String(item.message || item.error || '')).filter(Boolean);
        const message = thirdPartyPayoutsDisabled
          ? 'Paystack has not enabled third-party payouts for this account. No payroll was sent. Contact Paystack to enable transfers, then retry.'
          : `Paystack rejected the batch (HTTP ${response.status}): ${providerMessage}${providerErrorDetails.length ? ` ${providerErrorDetails.join('; ')}` : ''}`;
        const providerFailure = { status: response.status, message: providerMessage, errors: providerErrors };
        await db.update('payroll_items', itemIds.map((id: string, index: number) => ({ id, record: { ...payrollRecords[index], id, status: 'failed', error: message, providerFailure } })));
        await db.update('payroll_batches', [{ id: batchId, record: { id: batchId, tenantId: context.tenantId, provider: 'paystack', status: 'failed', totalKES, employeeCount: transfers.length, failedCount: transfers.length, createdAt: now, error: message, providerFailure } }]);
        return error(message, thirdPartyPayoutsDisabled ? 503 : 502);
      }
      const acceptedRows = Array.isArray(resultBody.data) ? resultBody.data : Array.isArray(resultBody.data?.success) ? resultBody.data.success : [];
      const failedReferences = new Set((Array.isArray(resultBody.data?.errors) ? resultBody.data.errors : []).map((item: any) => String(item.reference || '')));
      const [{ items: currentPayrollItems }] = await Promise.all([db.list('payroll_items', { limit: 5000 })]);
      const currentItemById = new Map((currentPayrollItems as any[]).map(item => [String(item.id), item]));
      const updatedItems = transfers.map((transfer, index) => {
        const result = acceptedRows.find((item: any) => String(item.reference || '') === transfer.reference);
        const currentItem: any = currentItemById.get(String(itemIds[index]));
        const finalizedByWebhook = ['success', 'failed', 'reversed', 'review'].includes(currentItem?.status);
        const omittedFromResponse = !result && !failedReferences.has(transfer.reference);
        const status = finalizedByWebhook ? currentItem.status : failedReferences.has(transfer.reference) ? 'failed' : omittedFromResponse ? 'review' : 'pending';
        return { id: itemIds[index], record: { ...payrollRecords[index], ...(currentItem || {}), id: itemIds[index], status, webhookIssue: omittedFromResponse ? 'Paystack omitted this reference from the bulk response. Verify it in the Paystack dashboard before retrying.' : currentItem?.webhookIssue, transferCode: result?.transfer_code || currentItem?.transferCode || null, responseStatus: result?.status || currentItem?.responseStatus || null } };
      });
      await db.update('payroll_items', updatedItems);
      const successCount = updatedItems.filter(item => item.record.status === 'success').length;
      const failedCount = updatedItems.filter(item => ['failed', 'reversed', 'review'].includes(item.record.status)).length;
      const pendingCount = updatedItems.length - successCount - failedCount;
      const batchStatus = successCount === updatedItems.length ? 'success' : successCount || failedCount ? 'partial' : 'pending';
      await db.update('payroll_batches', [{ id: batchId, record: { id: batchId, tenantId: context.tenantId, branchId: context.branchId || null, provider: 'paystack', status: batchStatus, totalKES, employeeCount: transfers.length, sentCount: successCount, pendingCount, failedCount, createdAt: now } }]);
      await audit('submitted', 'paystack_payroll_batch', { id: batchId, totalKES, employeeCount: transfers.length, pendingCount, failedCount, successCount }, context.name);
      return json({ id: batchId, totalKES, employeeCount: transfers.length, pendingCount, failedCount, successCount, status: batchStatus, message: 'Transfers are queued. Earnings will be marked paid only after Paystack confirms success.' });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Paystack transfer status is unknown.';
      await db.update('payroll_items', itemIds.map((id: string, index: number) => ({ id, record: { ...payrollRecords[index], id, status: 'unknown', error: message } })));
      await db.update('payroll_batches', [{ id: batchId, record: { id: batchId, tenantId: context.tenantId, provider: 'paystack', status: 'unknown', totalKES, employeeCount: transfers.length, createdAt: now, error: message } }]);
      return error('Paystack response was interrupted. Check the Paystack dashboard before retrying this batch.', 502);
    }
  }],
  'POST /api/paystack/webhook': [async ({ body, headers, rawBody }) => {
    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    const signatureHeader = headers['x-paystack-signature'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    if (!secret) return error('Paystack webhook is not configured.', 503);
    if (!verifyPaystackSignature(rawBody, signature, secret)) return error('Invalid Paystack webhook signature.', 401);
    const event = String(body?.event || '');
    if (!['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event)) return json({ received: true });
    const transfer = body?.data || {};
    const reference = String(transfer.reference || '');
    if (!reference) return json({ received: true });

    return withRequestContext({ accountId: 'paystack-webhook', tenantId: '', salonName: '', role: 'admin', name: 'Paystack webhook' }, async () => {
      const [{ items: payrollItems }] = await Promise.all([db.list('payroll_items', { limit: 5000 })]);
      const item: any = (payrollItems as any[]).find(record => record.provider === 'paystack' && record.reference === reference);
      if (!item) return json({ received: true });
      if (event === 'transfer.success') {
        if (['success', 'reversed'].includes(item.status)) return json({ received: true });
        const amountMatches = Number(transfer.amount) === Number(item.amount);
        const currencyMatches = String(transfer.currency || '').toUpperCase() === 'KES';
        const recipientMatches = !transfer.recipient?.recipient_code || transfer.recipient.recipient_code === item.recipientCode;
        if (!amountMatches || !currencyMatches || !recipientMatches) {
          await db.update('payroll_items', [{ id: item.id, record: { ...item, status: 'review', webhookIssue: 'Paystack transfer details did not match the submitted batch.', updatedAt: Date.now() } }]);
          return json({ received: true });
        }
        const [{ items: existingPayouts }] = await Promise.all([db.list('payout_items', { limit: 10000 })]);
        const activeKeys = new Set((existingPayouts as any[]).filter(record => !record.deletedAt).map(record => String(record.itemKey || '')));
        const payoutRows = (Array.isArray(item.earningLines) ? item.earningLines : []).filter((line: any) => !activeKeys.has(String(line.itemKey || ''))).map((line: any) => ({
          id: `paystack-${createHash('sha256').update(`${reference}:${line.itemKey}`).digest('hex')}`,
          tenantId: item.tenantId, branchId: line.branchId || item.branchId || null, batchId: item.batchId, provider: 'paystack', reference,
          itemKey: line.itemKey, orderId: line.orderId, staffId: line.staffId, serviceName: line.serviceName,
          role: line.role === 'assistant' ? 'assistant' : 'commission', amount: line.amount, currency: line.currency, orderCreatedAt: line.createdAt, createdAt: Date.now(),
        }));
        if (payoutRows.length) await db.add('payout_items', payoutRows);
        const payoutItemIds = payoutRows.map(row => row.id);
        await db.update('payroll_items', [{ id: item.id, record: { ...item, status: 'success', transferCode: transfer.transfer_code || item.transferCode, paidAt: Date.now(), payoutItemIds } }]);
      } else if (event === 'transfer.reversed' && item.status === 'success') {
        const now = Date.now();
        const payoutItemIds = new Set(Array.isArray(item.payoutItemIds) ? item.payoutItemIds : []);
        const [{ items: existingPayouts }] = await Promise.all([db.list('payout_items', { limit: 10000 })]);
        const reversals = (existingPayouts as any[]).filter(record => payoutItemIds.has(record.id) && !record.deletedAt)
          .map(record => ({ id: record.id, record: { ...record, deletedAt: now, deletionReason: 'Paystack transfer reversed' } }));
        if (reversals.length) await db.update('payout_items', reversals);
        await db.update('payroll_items', [{ id: item.id, record: { ...item, status: 'reversed', reversedAt: now } }]);
      } else if (event === 'transfer.failed' && !['success', 'reversed'].includes(item.status)) {
        await db.update('payroll_items', [{ id: item.id, record: { ...item, status: 'failed', failureReason: transfer.reason || transfer.message || 'Paystack transfer failed.', updatedAt: Date.now() } }]);
      }

      const [{ items: updatedItems }, [batch]] = await Promise.all([
        db.list('payroll_items', { limit: 5000 }), db.get('payroll_batches', [item.batchId]),
      ]);
      const batchItems = (updatedItems as any[]).filter(record => record.provider === item.provider && record.batchId === item.batchId);
      const terminal = batchItems.every(record => ['success', 'failed', 'reversed', 'review'].includes(record.status));
      const hasSuccess = batchItems.some(record => record.status === 'success');
      const failedCount = batchItems.filter(record => ['failed', 'reversed', 'review'].includes(record.status)).length;
      const batchStatus = batchItems.every(record => record.status === 'success') ? 'success' : terminal ? (hasSuccess ? 'partial' : 'failed') : (hasSuccess || failedCount ? 'partial' : 'pending');
      if (batch) await db.update('payroll_batches', [{ id: batch.id, record: { ...batch, status: batchStatus, sentCount: batchItems.filter(record => record.status === 'success').length, failedCount, updatedAt: Date.now() } }]);
      return json({ received: true });
    });
  }],

  'GET /api/dashboard': [async ({ query }) => {
    const requestedDate = String(query.date || '').trim();
    const selectedDay = requestedDate ? nairobiDayRange(requestedDate) : null;
    if (requestedDate && !selectedDay) return error('Choose a valid finance date', 400);
    if (selectedDay && currentContext()?.role !== 'owner') return error('Only the owner can view daily finance summaries', 403);
    const range = selectedDay ? 'day' : query.range || 'today';
    const now = Date.now();
    let cutoff = 0;
    let rangeEnd: number | null = null;
    if (selectedDay) { cutoff = selectedDay.from; rangeEnd = selectedDay.to; }
    else if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); cutoff = d.getTime(); }
    else if (range === 'week') cutoff = currentSundayThroughNowRange().from;
    else if (range === 'month') cutoff = now - 30 * DAY;
    else cutoff = 0;

    const [ordersResult, expensesResult, staffResult, productsResult, appointmentsResult, queueResult, customersResult, customersCountResult] = await Promise.all([
      db.list('orders', { limit: 5000 }),
      db.list('expenses', { limit: 500 }),
      db.list('staff', { limit: 2000 }),
      db.list('products', { limit: 500 }),
      db.list('appointments', { limit: 1000 }),
      db.list('queue', { limit: 200 }),
      db.list('customers', { limit: 10 }),
      db.count('customers'),
    ]);
    const orders = ordersResult.items;
    const expensesAll = expensesResult.items;
    const staffAll = staffResult.items;
    const productsAll = productsResult.items;
    const appts = (appointmentsResult.items as any[]).filter(item => !item.deletedAt);
    const queueAll = (queueResult.items as any[]).filter(item => !item.deletedAt);
    const customers = customersResult.items;
    const customersCount = customersCountResult;

    const staffById = new Map(staffAll.map((s: any) => [s.id, s]));
    const productById = new Map(productsAll.map((p: any) => [p.id, p]));
    const appointmentById = new Map(appts.map((appointment: any) => [appointment.id, appointment]));

    const rangeOrders = (orders as any[]).filter(order => {
      if (order.deletedAt) return false;
      const createdAt = Number(order.createdAt || 0);
      if (!selectedDay) return createdAt >= cutoff && (rangeEnd === null || createdAt < rangeEnd);
      if (!order.appointmentId) return createdAt >= selectedDay.from && createdAt < selectedDay.to;
      const appointment: any = appointmentById.get(String(order.appointmentId));
      return Boolean(appointment && !appointment.deletedAt && appointment.status === 'completed' && appointment.date === requestedDate);
    });
    const paymentMethodTotals: Record<'Cash' | 'Card' | 'M-Pesa', number> = { Cash: 0, Card: 0, 'M-Pesa': 0 };
    const revenueByCurrency: Record<string, number> = {};
    for (const o of rangeOrders) {
      const totals = o.totalByCurrency || (typeof o.total === 'number' ? { KES: o.total } : {});
      for (const c of Object.keys(totals)) revenueByCurrency[c] = (revenueByCurrency[c] || 0) + totals[c];
      const method = o.paymentMethod === 'Card' || o.paymentMethod === 'M-Pesa' ? o.paymentMethod : 'Cash';
      paymentMethodTotals[method as 'Cash' | 'Card' | 'M-Pesa'] += Number(totals.KES || 0);
    }

    let productCost = 0;
    const commissionsByCurrency: Record<string, number> = {};
    const staffRevenue = new Map<string, { name: string; currency: string; revenue: number; commission: number; helperDeductions: number; count: number }>();
    const staffEarnings = new Map<string, { staffId: string; name: string; currency: string; revenue: number; commission: number; assistantEarnings: number; helperDeductions: number; count: number }>();
    const addStaffEarning = (staffId: unknown, currency: string, values: { revenue?: number; commission?: number; assistantEarnings?: number; helperDeductions?: number; count?: number }) => {
      if (!staffId) return;
      const id = String(staffId);
      const member: any = staffById.get(id);
      const key = `${id}|${currency}`;
      const entry = staffEarnings.get(key) || { staffId: id, name: member?.name || 'Unknown', currency, revenue: 0, commission: 0, assistantEarnings: 0, helperDeductions: 0, count: 0 };
      entry.revenue += values.revenue || 0;
      entry.commission += values.commission || 0;
      entry.assistantEarnings += values.assistantEarnings || 0;
      entry.helperDeductions += values.helperDeductions || 0;
      entry.count += values.count || 0;
      staffEarnings.set(key, entry);
    };
    for (const member of staffAll as any[]) addStaffEarning(member.id, 'KES', {});
    const serviceRevenue = new Map<string, { name: string; currency: string; revenue: number; count: number }>();
    const commissionByClient: any[] = [];
    const topServicesMap = new Map<string, { name: string; currency: string; revenue: number; count: number }>();

    for (const order of rangeOrders as any[]) {
      for (const item of (order.items || []) as any[]) {
        if (item.type !== 'service') continue;
        const currency = item.currency === 'USD' ? 'USD' : 'KES';
        const revenue = Number(item.lineTotalAfterDiscount ?? (Number(item.price || 0) * Number(item.qty || 1)));
        const quantity = Number(item.qty || 1);
        const name = String(item.name || 'Service');
        const serviceEntry = topServicesMap.get(`${name}|${currency}`) || { name, currency, revenue: 0, count: 0 };
        serviceEntry.revenue += revenue;
        serviceEntry.count += quantity;
        topServicesMap.set(`${name}|${currency}`, serviceEntry);

        const staffIds = [item.staffId, item.coStaffId, item.thirdStaffId].filter(Boolean);
        for (const staffId of staffIds) {
          const member = staffById.get(String(staffId));
          if (!member) continue;
          let commission = 0;
          if (String(item.staffId || '') === String(staffId)) commission = Number(item.primaryCommission ?? staffCommission(item, staffId) ?? 0);
          if (String(item.coStaffId || '') === String(staffId)) commission = Number(item.coStaffCommission ?? 0);
          if (String(item.thirdStaffId || '') === String(staffId)) commission = Number(item.thirdStaffCommission ?? 0);
          commissionsByCurrency[currency] = (commissionsByCurrency[currency] || 0) + commission;
          commissionByClient.push({
            clientId: order.customerId || null,
            clientName: order.customerName || 'Customer',
            staffName: member.name,
            serviceName: name,
            revenue,
            assistantPayment: Number(item.assistantPayment || item.helperDeduction || 0),
            commission,
            currency,
            createdAt: Number(order.createdAt || 0),
          });
        }
        productCost += Number(item.productCost || 0) * quantity;
      }
    }

    const trend: any[] = [];
    const trendDays = range === 'month' ? 30 : range === 'week' ? 7 : range === 'today' ? 1 : 14;
    for (let offset = trendDays - 1; offset >= 0; offset--) {
      const date = new Date(now - offset * DAY);
      const key = nairobiDateString(date);
      const dayStart = new Date(`${key}T00:00:00+03:00`).getTime();
      const dayEnd = dayStart + DAY;
      const revenue = (rangeOrders as any[])
        .filter(order => Number(order.createdAt || 0) >= dayStart && Number(order.createdAt || 0) < dayEnd)
        .reduce((sum, order) => sum + Number(order.totalByCurrency?.KES || 0), 0);
      trend.push({ date: key, revenue });
    }

    const result = {
      range,
      revenueByCurrency,
      ordersCount: rangeOrders.length,
      paymentMethodTotals,
      expenseTotal: (expensesAll as any[]).filter(expense => !expense.deletedAt).reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
      productCost,
      commissionsByCurrency,
      estimatedProfitByCurrency: {
        KES: Number(revenueByCurrency.KES || 0) - productCost - Number((expensesAll as any[]).filter(expense => !expense.deletedAt).reduce((sum, expense) => sum + Number(expense.amount || 0), 0)),
        USD: Number(revenueByCurrency.USD || 0),
      },
      todaysAppointmentsCount: appts.filter((appointment: any) => appointment.date === nairobiDateString()).length,
      upcomingAppointments: appts.filter((appointment: any) => !['cancelled', 'no-show', 'completed'].includes(appointment.status)).slice(0, 20),
      activeStaffCount: (staffAll as any[]).filter((member: any) => !member.deletedAt && member.employmentStatus !== 'laid-off').length,
      totalStaffCount: (staffAll as any[]).filter((member: any) => !member.deletedAt).length,
      waitingQueueCount: queueAll.filter((entry: any) => entry.status !== 'completed').length,
      customersCount,
      customers,
      topStaff: Array.from(staffEarnings.values()).sort((a: any, b: any) => (b.revenue || 0) - (a.revenue || 0)).slice(0, 10),
      topServices: Array.from(topServicesMap.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
      commissionByClient: commissionByClient.slice(-50).reverse(),
      staffEarnings: Array.from(staffEarnings.values()).sort((a: any, b: any) => (b.revenue || 0) - (a.revenue || 0)),
      trend,
    };
    return json(result);
  }],

  'POST /api/ai/ask': [async ({ body }) => {
    const question = String(body?.question || '').trim().toLowerCase();
    const [{ items: orders }, { items: staff }, { items: products }, { items: customers }] = await Promise.all([
      db.list('orders', { limit: 10000 }), db.list('staff', { limit: 5000 }), db.list('products', { limit: 5000 }), db.list('customers', { limit: 10000 }),
    ]);
    if (question.includes('low stock') || question.includes('restock') || question.includes('inventory')) {
      const low = (products as any[]).filter(product => Number(product.stock || 0) <= Number(product.lowStockThreshold || 0));
      if (!low.length) return json({ answer: 'No products are currently below their low-stock threshold.', grounded: true });
      return json({ answer: `${low.length} product${low.length === 1 ? '' : 's'} need restocking: ${low.slice(0, 10).map(product => product.name).join(', ')}.`, grounded: true });
    }
    if (question.includes('top staff') || question.includes('top performer')) {
      const totals = new Map<string, number>();
      for (const order of orders as any[]) for (const item of (order.items || []) as any[]) if (item.type === 'service' && item.staffName) {
        totals.set(item.staffName, (totals.get(item.staffName) || 0) + Number(item.price || 0) * Number(item.qty || 1));
      }
      const top = Array.from(totals.entries()).sort((a, b) => b[1] - a[1])[0];
      return json({ answer: top ? `${top[0]} leads recorded service sales with KES ${Math.round(top[1]).toLocaleString()}.` : 'No staff sales have been recorded yet.', grounded: true });
    }
    if (question.includes('inactive customer') || question.includes('inactive customers')) {
      const inactive = (customers as any[]).filter(customer => !customer.lastVisit || Number(customer.lastVisit) < Date.now() - 60 * DAY);
      return json({ answer: inactive.length ? `${inactive.length} customers have not visited in over 60 days.` : 'No inactive customers were found.', grounded: true });
    }
    return json({ answer: 'I can answer from recorded revenue, top staff, low stock, and inactive customer data.', grounded: false });
  }],
  'GET /api/reports/staff-performance': [async () => {
    const context = currentContext();
    if (!context || !['owner', 'manager', 'admin'].includes(context.role)) return error('Access denied', 403);
    const { items: staff } = await db.list('staff', { limit: 5000 });
    const { items: orders } = await db.list('orders', { limit: 10000 });
    const { items: appointments } = await db.list('appointments', { limit: 10000 });
    const { items: payouts } = await db.list('payout_items', { limit: 10000 });
    const now = Date.now();
    const weekRange = currentSaturdayThroughFridayRange();
    const lastWeekRange = currentSaturdayThroughFridayRange(new Date(now - 7 * DAY));
    const monthRange = currentSundayThroughNowRange();
    const lastMonthRange = currentSundayThroughNowRange(new Date(now - 30 * DAY));

    const staffIds = staff.map(member => String(member.id));
    const orderIds = new Set(orders.filter(order => !order.deletedAt).map(order => String(order.id)));
    const appointmentIds = new Set(appointments.filter(appointment => !appointment.deletedAt).map(appointment => String(appointment.id)));
    const payoutOrderIds = new Set(payouts.filter(payout => !payout.deletedAt).map(payout => String(payout.orderId)));

    const calculateStaffEarnings = (scopedOrders: any[], scopedPayouts: any[], from: number, to: number) => {
      const earnings: any[] = [];
      for (const order of scopedOrders) {
        for (const item of (order.items || [])) {
          if (item.type !== 'service') continue;
          const staffIds = [item.staffId, item.coStaffId, item.thirdStaffId].filter(Boolean);
          for (const staffId of staffIds) {
            const amount = staffCommission(item, staffId);
            if (!amount) continue;
            const existing = earnings.find(earning => earning.staffId === staffId);
            if (existing) {
              existing.amount += amount;
              existing.orderCount += 1;
            } else {
              earnings.push({ staffId, amount, orderCount: 1 });
            }
          }
        }
      }
      for (const payout of scopedPayouts) {
        const staffId = payout.staffId;
        const existing = earnings.find(earning => earning.staffId === staffId);
        if (existing) {
          existing.amount += Number(payout.commission || 0);
          existing.orderCount += 1;
        } else {
          earnings.push({ staffId, amount: Number(payout.commission || 0), orderCount: 1 });
        }
      }
      return earnings;
    };

    const staffEarningsCurrentWeek = calculateStaffEarnings(orders.filter(order => {
      const createdAt = Number(order.createdAt);
      return !order.deletedAt && createdAt >= weekRange.from && createdAt < weekRange.to;
    }), payouts.filter(payout => {
      const createdAt = Number(payout.createdAt);
      return !payout.deletedAt && createdAt >= weekRange.from && createdAt < weekRange.to;
    }), weekRange.from, weekRange.to);

    const staffEarningsLastWeek = calculateStaffEarnings(orders.filter(order => {
      const createdAt = Number(order.createdAt);
      return !order.deletedAt && createdAt >= lastWeekRange.from && createdAt < lastWeekRange.to;
    }), payouts.filter(payout => {
      const createdAt = Number(payout.createdAt);
      return !payout.deletedAt && createdAt >= lastWeekRange.from && createdAt < lastWeekRange.to;
    }), lastWeekRange.from, lastWeekRange.to);

    const staffEarningsCurrentMonth = calculateStaffEarnings(orders.filter(order => {
      const createdAt = Number(order.createdAt);
      return !order.deletedAt && createdAt >= monthRange.from && createdAt < monthRange.to;
    }), payouts.filter(payout => {
      const createdAt = Number(payout.createdAt);
      return !payout.deletedAt && createdAt >= monthRange.from && createdAt < monthRange.to;
    }), monthRange.from, monthRange.to);

    const staffEarningsLastMonth = calculateStaffEarnings(orders.filter(order => {
      const createdAt = Number(order.createdAt);
      return !order.deletedAt && createdAt >= lastMonthRange.from && createdAt < lastMonthRange.to;
    }), payouts.filter(payout => {
      const createdAt = Number(payout.createdAt);
      return !payout.deletedAt && createdAt >= lastMonthRange.from && createdAt < lastMonthRange.to;
    }), lastMonthRange.from, lastMonthRange.to);

    const topStaffCurrentWeek = staffEarningsCurrentWeek.sort((a, b) => b.amount - a.amount).slice(0, 10);
    const topStaffLastWeek = staffEarningsLastWeek.sort((a, b) => b.amount - a.amount).slice(0, 10);
    const topStaffCurrentMonth = staffEarningsCurrentMonth.sort((a, b) => b.amount - a.amount).slice(0, 10);
    const topStaffLastMonth = staffEarningsLastMonth.sort((a, b) => b.amount - a.amount).slice(0, 10);

    return json({
      currentWeek: { range: weekRange, earnings: staffEarningsCurrentWeek, topStaff: topStaffCurrentWeek },
      lastWeek: { range: lastWeekRange, earnings: staffEarningsLastWeek, topStaff: topStaffLastWeek },
      currentMonth: { range: monthRange, earnings: staffEarningsCurrentMonth, topStaff: topStaffCurrentMonth },
      lastMonth: { range: lastMonthRange, earnings: staffEarningsLastMonth, topStaff: topStaffLastMonth },
    });
  }],
  'GET /api/staff': [async () => {
    const context = currentContext();
    const { items } = await db.list('staff', { limit: 200 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt && (context?.role === 'admin' || !context?.tenantId || item.tenantId === context.tenantId) && (!context?.branchId || !item.branchId || item.branchId === context.branchId)) });
  }],
  'GET /api/services': [async () => {
    const { items } = await db.list('services', { limit: 500 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt) });
  }],
  'GET /api/customers': [async () => {
    const context = currentContext();
    const { items } = await db.list('customers', { limit: 1000 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt && (context?.role === 'admin' || !context?.tenantId || item.tenantId === context.tenantId) && (!context?.branchId || !item.branchId || item.branchId === context.branchId)) });
  }],
  'GET /api/reviews': [async ({ query }) => {
    const context = currentContext();
    const staffId = String(query.staffId || '').trim();
    const { items } = await db.list('reviews', { limit: 1000 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt && (!staffId || String(item.staffId || '') === staffId) && (context?.role === 'admin' || !context?.tenantId || item.tenantId === context.tenantId) && (!context?.branchId || !item.branchId || item.branchId === context.branchId)) });
  }],
  'GET /api/complaints': [async () => {
    const context = currentContext();
    if (!context || !['owner', 'admin', 'manager', 'receptionist', 'barber'].includes(context.role)) return error('Staff access is required', 403);
    const { items } = await db.list('complaints', { limit: 2000 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)) });
  }],
});