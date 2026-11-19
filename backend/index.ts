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

function requireServiceCreator() {
  return ['owner', 'admin', 'receptionist'].includes(currentContext()?.role || '');
}

async function hasReceptionistAppointmentPrivileges(context = currentContext()) {
  if (context?.role !== 'receptionist') return false;
  if (context.name.trim().toLowerCase() === 'nellius') return true;
  if (!context.branchId) return false;
  const [branch] = await db.get('branches', [context.branchId]);
  return String(branch?.name || '').trim().toLowerCase().includes('kamakis');
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
  'GET /api/public/salons': [async () => {
    const { items } = await db.list('salons', { limit: 5000 });
    return json({ items: (items as any[]).filter(salon => salon.status === 'active').map(salon => ({ id: salon.id, name: salon.name })) });
  }],
  'GET /api/public/branches': [async ({ query }) => {
    const salonId = String(query.salonId || '').trim();
    if (!salonId) return error('Salon is required', 400);
    const { items } = await db.list('branches', { limit: 5000 });
    return json({ items: (items as any[]).filter(branch => branch.salonId === salonId && branch.status === 'active') });
  }],
  'POST /api/auth/login': [async ({ body }) => {
    const identifier = String(body?.identifier || '').trim().toLowerCase();
    const credential = String(body?.credential || '').trim();
    if (!identifier || !credential) return error('Email or phone and password or PIN are required', 400);
    const { items } = await db.list('accounts', { limit: 5000 });
    const normalizedPhone = normalizeCustomerPhone(identifier);
    const account = (items as any[]).find(item => !item.deletedAt && item.status === 'active' && (
      String(item.email || '').toLowerCase() === identifier
      || String(item.phone || '').replace(/\D/g, '') === normalizedPhone
      || normalizeCustomerPhone(item.phone) === normalizedPhone
    ));
    if (!account) return error('Invalid login details', 401);
    const matchesPassword = account.passwordHash ? passwordMatches(credential, account.passwordHash) : false;
    const matchesPin = account.pinHash ? passwordMatches(credential, account.pinHash) : false;
    if (!matchesPassword && !matchesPin) return error('Invalid login details', 401);
    const token = sessionToken();
    await db.add('sessions', [sessionRecord(token, account)]);
    return json({ token, account: { id: account.id, name: account.name, email: account.email, phone: account.phone, role: normalizeRole(account.role), salonId: account.tenantId, salonName: account.salonName, branchId: account.branchId, staffId: account.staffId, requiresPinChange: account.requiresPinChange } });
  }],
  'POST /api/auth/signup': [async ({ body }) => {
    const name = String(body?.name || '').trim();
    const phone = String(body?.phone || '').trim();
    const pin = String(body?.pin || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    const salonId = String(body?.salonId || '').trim();
    const branchId = String(body?.branchId || '').trim();
    if (!name || !phone || !/^\d{4}$/.test(pin) || !salonId || !branchId) return error('Name, phone, 4-digit PIN, salon and branch are required', 400);
    const { items: accounts } = await db.list('accounts', { limit: 5000 });
    if ((accounts as any[]).some(account => !account.deletedAt && (String(account.phone || '').replace(/\D/g, '') === normalizeCustomerPhone(phone) || (email && String(account.email || '').toLowerCase() === email)))) return error('An account already exists for these details', 409);
    const accountId = `account-${randomBytes(8).toString('hex')}`;
    const [salon] = await db.get('salons', [salonId]);
    const [branch] = await db.get('branches', [branchId]);
    if (!salon || !branch || branch.salonId !== salonId) return error('Choose a valid salon and branch', 400);
    const account = { id: accountId, tenantId: salonId, salonName: salon.name, branchId, name, email, phone, role: 'customer', status: 'active', pinHash: passwordHash(pin), createdAt: Date.now() };
    await db.add('accounts', [account]);
    const customerId = `customer-${randomBytes(8).toString('hex')}`;
    await db.add('customers', [{ id: customerId, tenantId: salonId, branchId, name, phone, email, loyaltyPoints: 0, totalSpent: 0, totalSpentUSD: 0, visits: 0, lastVisit: null, createdAt: Date.now() }]);
    const token = sessionToken();
    await db.add('sessions', [sessionRecord(token, account)]);
    return json({ token, account: { id: account.id, name, email, phone, role: account.role, salonId, salonName: salon.name, branchId } });
  }],
  'GET /api/staff': [async () => {
    const context = currentContext();
    const { items } = await db.list('staff', { limit: 500 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt && (context?.role === 'admin' || !context?.tenantId || item.tenantId === context.tenantId) && (!context?.branchId || !item.branchId || item.branchId === context.branchId)) });
  }],
  'GET /api/services': [async () => {
    const { items } = await db.list('services', { limit: 500 });
    return json({ items: (items as any[]).filter(item => !item.deletedAt) });
  }],
  'GET /api/appointments': [async ({ query }) => {
    const context = currentContext();
    const { items: appointments } = await db.list('appointments', { limit: 5000 });
    const { items: orders } = await db.list('orders', { limit: 5000 });
    const active = (appointments as any[]).filter(item => !item.deletedAt);
    const visible = context?.role === 'barber' && context.staffId
      ? active.filter(item => String(item.staffId || '') === String(context.staffId) || (Array.isArray(item.items) && item.items.some((line: any) => String(line.staffId || '') === String(context.staffId))))
      : active;
    const paidIds = new Set((orders as any[]).filter(order => !order.deletedAt && order.appointmentId).map(order => String(order.appointmentId)));
    const items = visible.map(item => ({ ...item, paymentCompleted: paidIds.has(String(item.id)) }));
    const date = String(query.date || '').trim();
    return json({ items: date ? items.filter(item => item.date === date) : items });
  }],
  'POST /api/appointments': [async ({ body }) => {
    const context = currentContext();
    if (!context || !['owner', 'admin', 'manager', 'receptionist', 'barber'].includes(context.role)) return error('You cannot create appointments', 403);
    const name = String(body?.customerName || '').trim();
    const date = String(body?.date || '').trim();
    const time = String(body?.time || '').trim();
    const serviceName = String(body?.serviceName || '').trim();
    if (!name || !date || !time || !serviceName) return error('Customer, date, time and service are required', 400);
    const id = `appointment-${randomBytes(8).toString('hex')}`;
    const ticketNumber = createTicketNumber(date);
    const cardNumber = appointmentCardNumber(body?.cardNumber);
    const [branch] = context.branchId ? await db.get('branches', [context.branchId]) : [null];
    const appointment = { id, tenantId: context.tenantId, branchId: context.branchId || '', branchName: branch?.name || '', customerId: body?.customerId || null, customerName: name, customerPhone: String(body?.customerPhone || '').trim(), serviceId: body?.serviceId || null, serviceName, staffId: body?.staffId || null, staffName: body?.staffName || null, date, time, durationMin: Number(body?.durationMin || 30), price: Number(body?.price || 0), currency: body?.currency || 'KES', cardNumber, ticketNumber, status: 'pending', createdAt: Date.now() };
    await db.add('appointments', [appointment]);
    await audit('created', 'appointment', { id, customerName: name, date, time, serviceName, ticketNumber }, context.name);
    return json({ id, ticketNumber });
  }],
  'PUT /api/appointments/:id': [async ({ params, body }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const [existing] = await db.get('appointments', [params.id]);
    if (!existing) return error('Appointment not found', 404);
    const allowed = ['owner', 'admin', 'manager', 'receptionist'].includes(context.role);
    const barberStatus = context.role === 'barber' && body?.status !== undefined;
    if (!allowed && !barberStatus) return error('You cannot edit appointments', 403);
    const updated = { ...existing };
    if (allowed) {
      for (const key of ['customerName', 'customerPhone', 'serviceId', 'serviceName', 'staffId', 'staffName', 'date', 'time', 'durationMin', 'price', 'currency', 'cardNumber', 'status']) if (body?.[key] !== undefined) updated[key] = body[key];
    } else if (body?.status !== undefined) updated.status = body.status;
    await db.update('appointments', [{ id: params.id, record: updated }]);
    await audit('updated', 'appointment', { id: params.id, status: updated.status }, context.name);
    return json({ ok: true, item: updated });
  }],
  'DELETE /api/appointments/:id': [async ({ params }) => {
    const context = currentContext();
    if (!context || !['owner', 'admin', 'receptionist'].includes(context.role)) return error('Only owners, administrators and receptionists can delete appointments', 403);
    if (params.id === 'cancelled') {
      const { items } = await db.list('appointments', { limit: 5000 });
      const records = (items as any[]).filter(item => item.status === 'cancelled' && !item.deletedAt);
      for (const record of records) await db.update('appointments', [{ id: record.id, record: { ...record, deletedAt: Date.now(), deletedBy: context.name } }]);
      return json({ ok: true, deleted: records.length });
    }
    const [existing] = await db.get('appointments', [params.id]);
    if (!existing) return error('Appointment not found', 404);
    await db.update('appointments', [{ id: params.id, record: { ...existing, deletedAt: Date.now(), deletedBy: context.name } }]);
    await audit('deleted', 'appointment', { id: params.id, customerName: existing.customerName }, context.name);
    return json({ ok: true });
  }],
  'POST /api/orders': [async ({ body }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) return error('Add a service or product before checkout', 400);
    const id = `order-${randomBytes(8).toString('hex')}`;
    const totals: Record<string, number> = { KES: 0, USD: 0 };
    for (const item of items) { const currency = item.currency === 'USD' ? 'USD' : 'KES'; totals[currency] += Number(item.price || 0) * Number(item.qty || 1); }
    const discountPct = Math.max(0, Math.min(100, Number(body?.discountPct || 0)));
    const totalByCurrency = { KES: Math.round(totals.KES * (1 - discountPct / 100)), USD: Math.round(totals.USD * (1 - discountPct / 100)) };
    const order = { id, tenantId: context.tenantId, branchId: context.branchId || '', appointmentId: body?.appointmentId || null, customerId: body?.customerId || null, customerName: String(body?.customerName || 'Walk-in Customer'), items, discountPct, paymentMethod: body?.paymentMethod || 'Cash', mpesaReceiptNumber: body?.mpesaReceiptNumber || null, totalByCurrency, createdAt: Date.now() };
    await db.add('orders', [order]);
    if (body?.appointmentId) {
      const [appointment] = await db.get('appointments', [String(body.appointmentId)]);
      if (appointment) await db.update('appointments', [{ id: String(body.appointmentId), record: { ...appointment, status: 'completed', paymentCompleted: true } }]);
    }
    await audit('checkout', 'order', { id, appointmentId: body?.appointmentId || null, totalByCurrency, paymentMethod: order.paymentMethod }, context.name);
    return json({ id, item: order, totalByCurrency, createdAt: order.createdAt });
  }],
  'GET /api/_healthcheck': [async () => json({ ok: true })],
  'GET /api/dashboard': [async ({ query }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const [{ items: orders }, { items: appointments }, { items: staff }, { items: customers }, { items: queue }, { items: expenses }] = await Promise.all([
      db.list('orders', { limit: 10000 }), db.list('appointments', { limit: 10000 }), db.list('staff', { limit: 5000 }),
      db.list('customers', { limit: 10000 }), db.list('queue', { limit: 10000 }), db.list('expenses', { limit: 10000 }),
    ]);
    const inScope = (record: any) => !record.deletedAt && (context.role === 'admin' || !context.tenantId || !record.tenantId || record.tenantId === context.tenantId) && (!context.branchId || !record.branchId || record.branchId === context.branchId);
    const range = String(query.range || 'today');
    const dayStart = new Date(`${nairobiDateString()}T00:00:00+03:00`).getTime();
    const from = range === 'today' ? dayStart : range === 'week' ? mostRecentSaturdayThroughFridayRange().from : range === 'month' ? new Date(`${nairobiDateString().slice(0, 7)}-01T00:00:00+03:00`).getTime() : 0;
    const scopedOrders = (orders as any[]).filter(inScope).filter(order => range === 'all' || Number(order.createdAt || 0) >= from);
    const revenueByCurrency: Record<string, number> = { KES: 0, USD: 0 };
    const paymentMethodTotals: Record<'Cash' | 'Card' | 'M-Pesa', number> = { Cash: 0, Card: 0, 'M-Pesa': 0 };
    for (const order of scopedOrders) {
      const totals = order.totalByCurrency || {};
      revenueByCurrency.KES += Number(totals.KES || 0); revenueByCurrency.USD += Number(totals.USD || 0);
      const method = String(order.paymentMethod || 'Cash');
      if (method === 'Card' || method === 'M-Pesa') paymentMethodTotals[method] += Number(totals.KES || 0); else paymentMethodTotals.Cash += Number(totals.KES || 0);
    }
    const today = nairobiDateString();
    const expenseTotal = (expenses as any[]).filter(inScope).reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    const scopedAppointments = (appointments as any[]).filter(inScope);
    const scopedCustomers = (customers as any[]).filter(inScope);
    const scopedStaff = (staff as any[]).filter(inScope);
    return json({ range, revenueByCurrency, ordersCount: scopedOrders.length, paymentMethodTotals, expenseTotal, productCost:  0, commissionsByCurrency: { KES: 0, USD: 0 }, estimatedProfitByCurrency: { KES: revenueByCurrency.KES - expenseTotal, USD: revenueByCurrency.USD }, todaysAppointmentsCount: scopedAppointments.filter(item => item.date === today).length, upcomingAppointments: scopedAppointments.filter(item => item.date >= today && !['cancelled', 'no-show', 'completed'].includes(item.status)).slice(0, 20), activeStaffCount: scopedStaff.filter(item => item.employmentStatus !== 'laid-off').length, totalStaffCount: scopedStaff.length, waitingQueueCount: (queue as any[]).filter(inScope).filter(item => item.status !== 'completed').length, customersCount: scopedCustomers.length, customers: scopedCustomers.slice(0, 100), topStaff: [], commissionByClient: [], staffEarnings: [] });
  }],
  'GET /api/analytics/rebooking': [async () => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const { items: appointments } = await db.list('appointments', { limit: 10000 });
    const items = (appointments as any[]).filter(item => !item.deletedAt && item.status === 'completed' && (context.role === 'admin' || !context.branchId || !item.branchId || item.branchId === context.branchId)).map(item => ({ id: item.id, customerId: item.customerId || null, customerName: item.customerName || 'Customer', lastAppointmentDate: item.date, lastServiceName: item.serviceName || 'Service', daysSinceCompleted: Math.max(0, Math.floor((Date.now() - new Date(`${item.date}T00:00:00+03:00`).getTime()) / 86400000)), isRebooked: false })).slice(0, 500);
    return json({ items });
  }],
});