import { router, json, error, db, ai, storage, currentContext } from './runtime.ts';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const DAY = 24 * 3600 * 1000;

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
function assistantCompensation(serviceFee: unknown, hasSpecialBraid = false): number {
  if (hasSpecialBraid) return 400;
  const amount = Math.max(0, Number(serviceFee) || 0);
  if (amount <= 1800) return 200;
  if (amount <= 2400) return 300;
  if (amount <= 3300) return 400;
  return 500;
}
function hasSpecialAssistantBraid(item: any): boolean {
  return (item.consumedProducts || []).some((product: any) => ['amara', 'diani', 'marley imported', 'marley angel'].includes(String(product?.name || '').trim().toLowerCase()));
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

function serviceCommission(item: any): number {
  if (item?.type !== 'service') return 0;
  const recorded = Number(item.commission);
  if (Number.isFinite(recorded)) return Math.max(0, recorded);
  const revenue = Number(item.lineTotalAfterDiscount ?? Number(item.price || 0) * Number(item.qty || 1)) || 0;
  const productCost = Math.max(0, Number(item.productCost || 0));
  const assistantCompensation = Math.max(0, Number(item.assistantPayment ?? item.helperDeduction ?? 0));
  const commissionBase = Math.max(0, Number(item.commissionBase ?? (revenue - productCost - assistantCompensation)) || 0);
  const rate = Number(item.commissionPct ?? item.commissionRate ?? 50);
  return commissionBase * (Number.isFinite(rate) ? rate / 100 : 0.5);
}

function staffCommission(item: any, staffId: unknown): number {
  if (!staffId) return 0;
  const hasMultipleStaff = Boolean(item.coStaffId || item.thirdStaffId || item.helperStaffId);
  if (String(item.staffId || '') === String(staffId)) return hasMultipleStaff ? Number(item.primaryCommission ?? serviceCommission(item)) || 0 : serviceCommission(item);
  if (String(item.coStaffId || '') === String(staffId)) return Number(item.coStaffCommission ?? serviceCommission(item)) || 0;
  if (String(item.thirdStaffId || '') === String(staffId)) return Number(item.thirdStaffCommission ?? 0) || 0;
  return 0;
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
  const subject = employmentStatus === 'laid-off' ? 'SafiGroom employment update' : 'Welcome back to SafiGroom';
  const message = employmentStatus === 'laid-off'
    ? `Hello ${staff.name},\n\nThis email confirms that your employment with SafiGroom has ended, effective immediately. Please contact the business owner if you have questions about your final commission statement.`
    : `Hello ${staff.name},\n\nThis email confirms that you are employed by SafiGroom again. Your compensation is 50% commission after product and helper deductions.${initialPassword ? `\n\nLogin email: ${staff.accountEmail}\nTemporary password: ${initialPassword}\nPlease change this password after signing in.` : ''}`;
  await notifyCustomer(staff.accountEmail, subject, message, staff.id);
}

async function audit(action: string, collection: string, record: any, actor = 'system') {
  await db.add('audit_logs', [{
    action, collection, actor, recordId: record?.id || null,
    summary: `${action} ${collection}${record?.name ? `: ${record.name}` : record?.customerName ? `: ${record.customerName}` : ''}`,
    recordSnapshot: record,
    createdAt: Date.now(),
  }]);
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
    const normalizedIdentifier = identifier.replace(/\s+/g, '');
    const account = (items as any[]).find(item => String(item.email || '').toLowerCase() === identifier.toLowerCase() || (normalizedIdentifier && String(item.phone || '').replace(/\s+/g, '') === normalizedIdentifier));
    if (!account || account.status !== 'active') return error('Invalid login details', 401);
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
    await notifyCustomer(ownerEmail, `Your SafiGroom owner account for ${name}`, `Salon: ${name}\nLogin email: ${ownerEmail}\nTemporary password: ${ownerPassword}\nPlease change the password after signing in.`, accountId);
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
    await notifyCustomer(account.email, 'Your SafiGroom password was reset', `Your password was reset by the platform administrator.\nLogin email: ${account.email}\nNew temporary password: ${newPassword}`, account.id);
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
  'GET /api/staff/me/earnings': [async () => {
    const context = currentContext();
    if (!context?.staffId || !['barber', 'receptionist'].includes(context.role)) return error('Only an employee can view this earnings summary', 403);
    const now = Date.now();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayFrom = dayStart.getTime();
    const fortnightFrom = now - 14 * DAY;

    const { items: orders } = await db.list('orders', { limit: 5000 });
    const linkedAppointmentIds = new Set<string>();
    let todayCommission = 0;
    let todayAssistant = 0;
    let fortnightCommission = 0;
    let fortnightAssistant = 0;
    const completedWork: { serviceName: string; createdAt: number; role: 'commission' | 'assistant'; amount: number }[] = [];

    for (const order of orders as any[]) {
      if (order.deletedAt) continue;
      if (!order.createdAt) continue;
      for (const item of order.items || []) {
        if (item.type !== 'service') continue;
        const assistant = Number(item.assistantPayment ?? item.helperDeduction ?? 0) || 0;
        if (sameStaffIdentity(item.staffId, item.staffName, context)) {
          const commission = staffCommission(item, item.staffId);
          if (order.createdAt >= todayFrom) todayCommission += commission;
          if (order.createdAt >= fortnightFrom) fortnightCommission += commission;
          completedWork.push({ serviceName: item.name || 'Service', createdAt: order.createdAt, role: 'commission', amount: commission });
          if (order.appointmentId) linkedAppointmentIds.add(String(order.appointmentId));
        }
        if (sameStaffIdentity(item.coStaffId, item.coStaffName, context)) {
          const commission = staffCommission(item, item.coStaffId);
          if (order.createdAt >= todayFrom) todayCommission += commission;
          if (order.createdAt >= fortnightFrom) fortnightCommission += commission;
          completedWork.push({ serviceName: item.name || 'Service', createdAt: order.createdAt, role: 'commission', amount: commission });
          if (order.appointmentId) linkedAppointmentIds.add(String(order.appointmentId));
        }
        if (sameStaffIdentity(item.thirdStaffId, item.thirdStaffName, context)) {
          const commission = staffCommission(item, item.thirdStaffId);
          if (order.createdAt >= todayFrom) todayCommission += commission;
          if (order.createdAt >= fortnightFrom) fortnightCommission += commission;
          completedWork.push({ serviceName: item.name || 'Service', createdAt: order.createdAt, role: 'commission', amount: commission });
          if (order.appointmentId) linkedAppointmentIds.add(String(order.appointmentId));
        }
        if (sameStaffIdentity(item.helperStaffId, item.helperStaffName, context)) {
          if (order.createdAt >= todayFrom) todayAssistant += assistant;
          if (order.createdAt >= fortnightFrom) fortnightAssistant += assistant;
          completedWork.push({ serviceName: item.name || 'Service', createdAt: order.createdAt, role: 'assistant', amount: assistant });
          if (order.appointmentId) linkedAppointmentIds.add(String(order.appointmentId));
        }
      }
    }

    const { items: appointments } = await db.list('appointments', { limit: 2000 });
    for (const appointment of appointments as any[]) {
      if (appointment.status !== 'completed') continue;
      if (linkedAppointmentIds.has(String(appointment.id || ''))) continue;

      let serviceValue = 0;
      if (Array.isArray(appointment.items) && appointment.items.length) {
        serviceValue = appointment.items
          .filter((item: any) => sameStaffIdentity(item?.staffId, item?.staffName, context))
          .reduce((sum: number, item: any) => sum + (Number(item.price || 0) * Number(item.qty || 1)), 0);
      } else if (sameStaffIdentity(appointment.staffId, appointment.staffName, context)) {
        serviceValue = Number(appointment.price || 0);
      }

      if (serviceValue <= 0) continue;
      const appointmentTs = new Date(`${appointment.date || ''}T00:00:00`).getTime();
      if (!Number.isFinite(appointmentTs)) continue;
      const derivedCommission = serviceValue * 0.5;
      if (appointmentTs >= todayFrom) todayCommission += derivedCommission;
      if (appointmentTs >= fortnightFrom) fortnightCommission += derivedCommission;
      completedWork.push({ serviceName: appointment.serviceName || 'Service', createdAt: appointmentTs, role: 'commission', amount: derivedCommission });
    }

    return json({
      today: { commission: todayCommission, assistant: todayAssistant, total: todayCommission + todayAssistant },
      fortnight: { commission: fortnightCommission, assistant: fortnightAssistant, total: fortnightCommission + fortnightAssistant },
      completedWork: completedWork.sort((left, right) => right.createdAt - left.createdAt).slice(0, 30),
    });
  }],
  'GET /api/audit-logs': [async ({ query }) => {
    const { items } = await db.list('audit_logs', { limit: 5000 });
    const collection = query.collection;
    const filtered = collection ? (items as any[]).filter(log => log.collection === collection) : items;
    return json({ items: (filtered as any[]).sort((a, b) => b.createdAt - a.createdAt) });
  }],

  'POST /api/seed': [async () => {
    return error('Demo data seeding is disabled. Create a real salon through owner signup.', 410);
    /* legacy demo seed disabled */
    const { items: existingStaff } = await db.list('staff', { limit: 200 });
    let seeded = false;
    if (existingStaff.length === 0) {
      await seedDemoData();
      seeded = true;
    }
    const { items: staffAfter } = await db.list('staff', { limit: 200 });
    await migrateExistingData(staffAfter as any[]);
    return json({ seeded, migrated: true });
  }],

  'GET /api/staff': [async () => { const { items } = await db.list('staff', { limit: 200 }); return json({ items }); }],
  'POST /api/staff': [async ({ body }) => {
    const b: any = body;
    if (!b.name) return error('Name is required', 400);
    const context = currentContext();
    const branchId = String(b.branchId || context?.branchId || '');
    const { items: branches } = await db.list('branches', { limit: 5000 });
    const branch = (branches as any[]).find(item => item.id === branchId && (context?.role === 'admin' || item.salonId === context?.tenantId) && item.status === 'active');
    if (!branch) return error('Choose a valid branch for this staff member', 400);
    if (!b.phone) return error('Employee phone is required', 400);
    const isReceptionist = String(b.role || '').toLowerCase().includes('reception');
    const credential = String(isReceptionist ? b.password || '' : b.pin || '');
    if (isReceptionist ? credential.length < 8 : !/^\d{4}$/.test(credential)) {
      return error(isReceptionist ? 'Receptionist password must be at least 8 characters' : 'Staff PIN must be exactly 4 digits', 400);
    }
    const [id] = await db.add('staff', [{ tenantId: branch.salonId, salonName: branch.salonName || context?.salonName || '', name: b.name, role: b.role || 'Staff', specialties: b.specialties || [], branch: branch.name, branchId: branch.id, branchName: branch.name, chair: b.chair || '', phone: b.phone || '', accountEmail: b.accountEmail || '', accountStatus: b.accountStatus || 'pending', employmentStatus: 'active', commissionPct: 50, status: b.status || 'available' }]);
    if (!id) return error('Failed to add staff', 500);
    await audit('created', 'staff', { id, name: b.name, role: b.role || 'Staff', accountEmail: b.accountEmail || '', commissionPct: 50 }, b.actor || 'owner');
    if (currentContext()) {
      const context = currentContext()!;
      await db.add('accounts', [{ id: `account-${randomBytes(8).toString('hex')}`, tenantId: branch.salonId, salonName: branch.salonName || context.salonName, branchId: branch.id, name: b.name, email: '', phone: b.phone, role: isReceptionist ? 'receptionist' : 'barber', status: 'active', ...(isReceptionist ? { passwordHash: passwordHash(credential) } : { pinHash: passwordHash(credential) }), staffId: id, createdAt: Date.now() }]);
    }
    return json({ id });
  }],
  'PUT /api/staff/:id': [async ({ params, body }) => {
    requireOwner();
    const [existing] = await db.get('staff', [params.id]);
    if (!existing) return error('Staff not found', 404);
    const patch: any = body;
    if (patch.password && String(patch.password).length < 8) return error('Password must be at least 8 characters', 400);
    const updated = { ...existing, ...patch };
    delete updated.password;
    updated.commissionPct = 50;
    if (patch.employmentStatus === 'laid-off') updated.status = 'off';
    const [ok] = await db.update('staff', [{ id: params.id, record: updated }]);
    if (!ok) return error('Update failed', 500);
    await audit(patch.employmentStatus && patch.employmentStatus !== existing.employmentStatus ? patch.employmentStatus : 'updated', 'staff', updated, patch.actor || 'owner');
    if (patch.employmentStatus && patch.employmentStatus !== existing.employmentStatus) await notifyEmployee(updated, patch.employmentStatus);
    const { items: accounts } = await db.list('accounts', { limit: 5000 });
    const account = (accounts as any[]).find(item => item.staffId === params.id);
    if (account) {
      const accountPatch = { ...account, name: updated.name, phone: updated.phone };
      if (String(patch.password || '')) {
        accountPatch.passwordHash = passwordHash(String(patch.password));
      }
      await db.update('accounts', [{ id: account.id, record: accountPatch }]);
    }
    return json({ ok: true });
  }],

  'GET /api/services': [async () => { const { items } = await db.list('services', { limit: 500 }); return json({ items }); }],
  'POST /api/services': [async ({ body }) => {
    const b: any = body;
    if (!b.name || !b.price) return error('Name and price are required', 400);
    const staffCount = serviceStaffCount(b.staffCount);
    const [id] = await db.add('services', [{ name: b.name, category: b.category || 'General', price: b.price, currency: b.currency === 'USD' ? 'USD' : 'KES', durationMin: b.durationMin || 30, description: b.description || '', staffCount, commissionPct: commissionPct(b.commissionPct, staffCount) }]);
    if (!id) return error('Failed to add service', 500);
    await audit('created', 'service', { id, name: b.name, category: b.category || 'General', price: b.price, currency: b.currency === 'USD' ? 'USD' : 'KES' }, b.actor || 'owner');
    return json({ id });
  }],
  'PUT /api/services/:id': [async ({ params, body }) => {
    requireOwner();
    const [existing] = await db.get('services', [params.id]);
    if (!existing) return error('Service not found', 404);
    const patch: any = body || {};
    if (patch.name !== undefined && !String(patch.name).trim()) return error('Name is required', 400);
    if (patch.price !== undefined && Number(patch.price) <= 0) return error('Price must be greater than zero', 400);
    const updated = {
      ...existing,
      name: patch.name !== undefined ? String(patch.name).trim() : existing.name,
      category: patch.category !== undefined ? String(patch.category || '').trim() || 'General' : existing.category,
      price: patch.price !== undefined ? Number(patch.price) : existing.price,
      currency: patch.currency === 'USD' ? 'USD' : patch.currency === 'KES' ? 'KES' : existing.currency,
      durationMin: patch.durationMin !== undefined ? Math.max(5, Number(patch.durationMin) || 30) : existing.durationMin,
      description: patch.description !== undefined ? String(patch.description || '') : existing.description,
      staffCount: patch.staffCount !== undefined ? serviceStaffCount(patch.staffCount) : serviceStaffCount(existing.staffCount),
      commissionPct: commissionPct(patch.commissionPct !== undefined ? patch.commissionPct : existing.commissionPct, patch.staffCount !== undefined ? patch.staffCount : existing.staffCount),
    };
    const [ok] = await db.update('services', [{ id: params.id, record: updated }]);
    if (!ok) return error('Update failed', 500);
    await audit('updated', 'service', { id: params.id, name: updated.name, category: updated.category, price: updated.price, currency: updated.currency }, patch.actor || currentContext()?.name || 'owner');
    return json({ ok: true });
  }],

  'GET /api/customers': [async () => {
    const { items } = await db.list('customers', { limit: 1000 });
    const allCustomers = items as any[];
    const customers = allCustomers.filter(customer => !customer.deletedAt);
    const byId = new Map(customers.map(customer => [String(customer.id), customer]));
    const byEmail = new Map(customers.filter(customer => customer.email).map(customer => [String(customer.email).toLowerCase(), customer]));
    const deletedById = new Map(allCustomers.filter(customer => customer.deletedAt).map(customer => [String(customer.id), customer]));

    const { items: appointments } = await db.list('appointments', { limit: 3000 });
    const toCreate: any[] = [];
    const customerRestores: { id: string; record: any }[] = [];
    const appointmentUpdates: { id: string; record: any }[] = [];

    for (const appointment of appointments as any[]) {
      if (!appointment?.customerName || appointment.deletedAt) continue;
      const appointmentCustomerId = String(appointment.customerId || '');
      const appointmentEmail = String(appointment.customerEmail || '').toLowerCase();
      const existing = (appointmentCustomerId && byId.get(appointmentCustomerId)) || (appointmentEmail && byEmail.get(appointmentEmail));
      if (existing) {
        if (appointment.customerId !== existing.id) {
          appointmentUpdates.push({ id: appointment.id, record: { ...appointment, customerId: existing.id } });
        }
        continue;
      }

      const deletedCustomer = appointmentCustomerId && deletedById.get(appointmentCustomerId);
      if (deletedCustomer) {
        const restored = { ...deletedCustomer, deletedAt: undefined, deletedBy: undefined };
        customerRestores.push({ id: restored.id, record: restored });
        byId.set(String(restored.id), restored);
        if (restored.email) byEmail.set(String(restored.email).toLowerCase(), restored);
        continue;
      }

      const newCustomerId = `customer-${randomBytes(8).toString('hex')}`;
      const record = {
        id: newCustomerId,
        name: appointment.customerName,
        phone: '',
        email: appointment.customerEmail || '',
        notes: 'Auto-created from appointment history',
        loyaltyPoints: 0,
        totalSpent: 0,
        totalSpentUSD: 0,
        visits: 0,
        lastVisit: null,
        createdAt: appointment.createdAt || Date.now(),
        membershipTier: 'none',
        membershipExpiry: null,
      };
      toCreate.push(record);
      if (appointmentCustomerId) byId.set(appointmentCustomerId, record);
      byId.set(String(record.id), record);
      if (record.email) byEmail.set(String(record.email).toLowerCase(), record);
      if (!appointment.customerId || appointment.customerId !== record.id) {
        appointmentUpdates.push({ id: appointment.id, record: { ...appointment, customerId: record.id } });
      }
    }

    if (toCreate.length) await db.add('customers', toCreate);
  if (customerRestores.length) await db.update('customers', customerRestores);
    if (appointmentUpdates.length) await db.update('appointments', appointmentUpdates);

    const { items: refreshed } = await db.list('customers', { limit: 3000 });
    return json({ items: (refreshed as any[]).filter(customer => !customer.deletedAt) });
  }],
  'POST /api/customers': [async ({ body }) => {
    const b: any = body;
    if (!b.name) return error('Name is required', 400);
    const [id] = await db.add('customers', [{ name: b.name, phone: b.phone || '', email: b.email || '', notes: b.notes || '', loyaltyPoints: 0, totalSpent: 0, totalSpentUSD: 0, visits: 0, lastVisit: null, createdAt: Date.now(), membershipTier: 'none', membershipExpiry: null }]);
    if (!id) return error('Failed to add customer', 500);
    await audit('created', 'customer', { id, name: b.name, phone: b.phone || '', email: b.email || '' }, b.actor || 'customer');
    return json({ id });
  }],
  'PUT /api/customers/:id': [async ({ params, body }) => {
    requireOwner();
    const [existing] = await db.get('customers', [params.id]);
    if (!existing) return error('Customer not found', 404);
    const patch: any = { ...(body as any) };
    const pin = String(patch.pin || '');
    delete patch.pin;
    if (pin && !/^\d{4}$/.test(pin)) return error('Client PIN must be exactly 4 digits', 400);
    const updated = { ...existing, ...patch };
    const [ok] = await db.update('customers', [{ id: params.id, record: updated }]);
    if (!ok) return error('Update failed', 500);
    await audit('updated', 'customer', updated, (body as any)?.actor || 'receptionist');
    const { items: accounts } = await db.list('accounts', { limit: 5000 });
    const account = (accounts as any[]).find(item => item.id === params.id || (item.role === 'customer' && item.email && item.email === updated.email));
    if (account) {
      const accountPatch = { ...account, name: updated.name, phone: updated.phone, email: updated.email };
      if (pin) accountPatch.pinHash = passwordHash(pin);
      await db.update('accounts', [{ id: account.id, record: accountPatch }]);
    }
    return json({ ok: true });
  }],
  'DELETE /api/customers/:id/records': [async ({ params }) => {
    requireOwner();
    const [customer] = await db.get('customers', [params.id]);
    if (!customer || customer.deletedAt) return error('Customer not found', 404);
    const collections = ['customers', 'appointments', 'queue', 'orders', 'reviews', 'membership_purchases', 'pos_drafts', 'notifications'];
    const deletedAt = Date.now();
    const deletedBy = currentContext()?.name || 'owner';
    const deleted: Record<string, number> = {};
    for (const collection of collections) {
      const { items } = await db.list(collection, { limit: 5000 });
      const matching = (items as any[]).filter(item => collection === 'customers' ? item.id === customer.id : item.customerId === customer.id || item.clientId === customer.id);
      if (!matching.length) continue;
      await db.update(collection, matching.map(item => ({ id: item.id, record: { ...item, deletedAt, deletedBy } })));
      deleted[collection] = matching.length;
    }
    await audit('deleted customer records', 'customer', { id: customer.id, name: customer.name, deleted }, deletedBy);
    return json({ deleted });
  }],
  'POST /api/customers/:id/pin': [async ({ params, body }) => {
    const context = currentContext();
    if (!context || !['owner', 'admin'].includes(context.role)) return error('Only the owner or administrator can change client PINs', 403);
    const pin = String(body?.pin || '');
    if (!/^\d{4}$/.test(pin)) return error('Client PIN must be exactly 4 digits', 400);
    const [customer] = await db.get('customers', [params.id]);
    if (!customer) return error('Customer not found', 404);
    const { items: accounts } = await db.list('accounts', { limit: 5000 });
    const account = (accounts as any[]).find(item => item.role === 'customer' && item.tenantId === context.tenantId && (item.id === customer.id || (customer.email && item.email === customer.email)));
    if (!account) return error('This customer does not have a client login account', 404);
    await db.update('accounts', [{ id: account.id, record: { ...account, pinHash: passwordHash(pin), pinResetAt: Date.now() } }]);
    await audit('updated', 'account', { id: account.id, name: account.name, email: account.email, action: 'client_pin_changed' }, context.name);
    return json({ ok: true });
  }],
  'GET /api/customer/dashboard': [async ({ query }) => {
    const search = String(query.query || query.email || query.phone || '').trim();
    const normalizedSearch = search.toLowerCase().replace(/\s+/g, '');
    if (!search) return error('A name, email or phone number is required', 400);
    const context = currentContext();
    const { items: customers } = context?.role === 'admin' ? await db.list('customers', { limit: 2000 }) : await db.listAllTenant('customers', context?.tenantId || '', { limit: 2000 });
    const activeCustomers = (customers as any[]).filter(item => !item.deletedAt);
    let customer = activeCustomers.find(item => [item.name, item.email, item.phone, item.id].some(value => String(value || '').toLowerCase().replace(/\s+/g, '').includes(normalizedSearch)));
    if (!customer && context?.role === 'customer') {
      const [account] = await db.get('accounts', [context.accountId]);
      if (account && [account.name, account.email, account.phone, account.id].some(value => String(value || '').toLowerCase().replace(/\s+/g, '').includes(normalizedSearch))) {
        const existingCustomer = activeCustomers.find(item => item.email === account.email);
        if (!existingCustomer) {
          customer = { id: `customer-${randomBytes(8).toString('hex')}`, name: account.name, phone: account.phone || '', email: account.email || '', notes: '', loyaltyPoints: 0, totalSpent: 0, totalSpentUSD: 0, visits: 0, lastVisit: null, createdAt: Date.now(), membershipTier: 'none', membershipExpiry: null };
          await db.add('customers', [customer]);
        } else {
          customer = existingCustomer;
        }
      }
    }
    if (!customer) return error('Customer profile not found', 404);
    const { items: appointments } = await db.list('appointments', { limit: 2000 });
    const { items: queue } = await db.list('queue', { limit: 2000 });
    const { items: reviews } = await db.list('reviews', { limit: 2000 });
    const { items: purchases } = await db.list('membership_purchases', { limit: 2000 });
    return json({
      customer,
      appointments: (appointments as any[]).filter(item => item.customerId === customer.id && !item.deletedAt).sort((a, b) => String(b.date).localeCompare(String(a.date))),
      queue: (queue as any[]).filter(item => item.customerId === customer.id && !item.deletedAt).sort((a, b) => b.joinedAt - a.joinedAt).slice(0, 10),
      reviews: (reviews as any[]).filter(item => item.customerId === customer.id && !item.deletedAt),
      membershipPurchases: (purchases as any[]).filter(item => item.customerId === customer.id && !item.deletedAt),
    });
  }],

  'GET /api/appointments': [async ({ query }) => {
    const { items } = await db.list('appointments', { limit: 1000 });
    const date = query.date;
    const context = currentContext();
    const activeItems = items.filter((appointment: any) => !appointment.deletedAt);
    const visible = context?.role === 'barber' ? activeItems.filter((a: any) => a.staffId === context.staffId) : activeItems;
    return json({ items: date ? visible.filter((a: any) => a.date === date) : visible });
  }],
  'POST /api/appointments': [async ({ body }) => {
    const b: any = body;
    const context = currentContext();
    const requestedBranchId = String(b.branchId || context?.branchId || '');
    const { items: branches } = await db.list('branches', { limit: 5000 });
    const branch = (branches as any[]).find(item => item.id === requestedBranchId && item.salonId === context?.tenantId && item.status === 'active');
    if (!branch) return error('Choose a valid branch for this appointment', 400);
    const requestedCategories = Array.isArray(b.serviceCategories) ? b.serviceCategories.slice(0, 2).filter(Boolean) : [];
    const items = Array.isArray(b.items) && b.items.length ? b.items : b.serviceId ? [{ serviceId: b.serviceId, serviceName: b.serviceName, price: b.price || 0, currency: b.currency || 'KES', durationMin: b.durationMin || 30, staffId: b.staffId, staffName: b.staffName }] : requestedCategories.length ? [{ serviceId: null, serviceName: `Requested: ${requestedCategories.join(' + ')}`, price: 0, currency: 'KES', durationMin: 30, staffId: b.staffId, staffName: b.staffName }] : [];
    const appointmentDate = b.date || new Date().toISOString().slice(0, 10);
    const appointmentTime = b.time || '00:00';
    if (b.cardNumber && !['owner', 'admin', 'receptionist'].includes(context?.role || '')) return error('Only the owner, administrator or receptionist can add a card number', 403);
    let cardNumber = '';
    try { cardNumber = appointmentCardNumber(b.cardNumber); } catch (cause: any) { return error(cause.message, 400); }
    if (!b.customerName || items.length === 0) return error('Missing required appointment fields', 400);
    for (const it of items) { if (!it.serviceId && !requestedCategories.length) return error('Each service needs a service selected', 400); }

    const { items: existing } = await db.list('appointments', { limit: 1000 });
    if (cardNumber && (existing as any[]).some(appointment => !appointment.deletedAt && appointment.date === appointmentDate && String(appointment.cardNumber || '') === cardNumber)) return error('This card number is already assigned on the selected date', 409);
    const totalDurationMin = items.reduce((s: number, it: any) => s + (it.durationMin || 30), 0);
    const totalPrice = items.reduce((s: number, it: any) => s + (it.price || 0), 0);
    const currency = items[0]?.currency || 'KES';
    const serviceName = items.map((it: any) => it.serviceName).join(', ');
    const staffNames = Array.from(new Set(items.map((it: any) => it.staffName).filter(Boolean)));
    let customerId = b.customerId || null;
    let customerEmail = b.customerEmail || '';
    const normalizedPhone = String(b.customerPhone || '').replace(/\s+/g, '');
    const { items: customers } = await db.list('customers', { limit: 2000 });
    const findExistingCustomer = () => (customers as any[]).find(customer => (customerId && customer.id === customerId)
      || (customerEmail && String(customer.email || '').toLowerCase() === String(customerEmail).toLowerCase())
      || (normalizedPhone && String(customer.phone || '').replace(/\s+/g, '') === normalizedPhone));

    if (customerId) {
      const [customer] = await db.get('customers', [customerId]);
      if (customer) {
        customerEmail = customer?.email || customerEmail;
      } else {
        const existingCustomer = findExistingCustomer();
        if (existingCustomer) customerId = existingCustomer.id;
      }
    }
    if (!customerId) {
      const existingCustomer = findExistingCustomer();
      if (existingCustomer) {
        customerId = existingCustomer.id;
      } else {
        [customerId] = await db.add('customers', [{ name: b.customerName, phone: b.customerPhone || '', email: customerEmail, notes: '', loyaltyPoints: 0, totalSpent: 0, totalSpentUSD: 0, visits: 0, lastVisit: null, createdAt: Date.now(), membershipTier: 'none', membershipExpiry: null }]);
      }
    }
    const [id] = await db.add('appointments', [{
      customerId, customerName: b.customerName,
      serviceId: items[0].serviceId, serviceName,
      customerEmail, staffId: items[0].staffId || null, staffName: staffNames.join(', ') || null,
      branchId: branch.id, branchName: branch.name,
      date: appointmentDate, time: appointmentTime, durationMin: totalDurationMin, price: totalPrice, currency,
      cardNumber,
      items, status: 'pending', createdAt: Date.now(),
    }]);
    if (!id) return error('Failed to create appointment', 500);

    const { items: activeQueue } = await db.list('queue', { limit: 2000 });
    const ticketNumber = createTicketNumber(appointmentDate);
    const [queueId] = await db.add('queue', [{
      appointmentId: id, customerId: customerId || null, customerEmail,
      customerName: b.customerName, serviceName, staffId: items[0].staffId || null,
      staffName: staffNames.join(', ') || null, status: 'waiting', joinedAt: Date.now(),
      branchId: branch.id, branchName: branch.name,
      position: activeQueue.filter((q: any) => q.status !== 'completed').length + 1, ticketNumber,
    }]);
    await notifyCustomer(customerEmail, `Booking request received: ticket ${ticketNumber}`, `Your SafiGroom booking request was received. Reception will confirm the exact service and time. Ticket: ${ticketNumber}.`, id);
    await audit('created', 'appointment', { id, customerId: b.customerId || null, customerName: b.customerName, serviceName, staffId: items[0].staffId || null, staffName: staffNames.join(', ') || null, date: appointmentDate, time: appointmentTime, ticketNumber }, b.actor || 'customer');
    return json({ id, queueId, ticketNumber, date: b.date || null, time: b.time || null });
  }],
  'PUT /api/appointments/:id': [async ({ params, body }) => {
    const context = currentContext();
    if (!context || !['owner', 'admin', 'receptionist', 'barber'].includes(context.role)) return error('You are not allowed to update appointments', 403);
    const [existing] = await db.get('appointments', [params.id]);
    if (!existing) return error('Appointment not found', 404);
    const patch: any = body;
    const canManageCardNumber = ['owner', 'admin', 'receptionist'].includes(context.role);
    if ('cardNumber' in patch && !canManageCardNumber) return error('Only the owner, administrator or receptionist can add a card number', 403);
    if (existing.cardNumber && 'cardNumber' in patch && String(patch.cardNumber || '') !== String(existing.cardNumber)) return error('A card number cannot be changed after it is entered', 409);
    if ('cardNumber' in patch) {
      try { patch.cardNumber = appointmentCardNumber(patch.cardNumber); } catch (cause: any) { return error(cause.message, 400); }
    }
    const canManageClosedAppointments = ['owner', 'admin'].includes(context.role);
    const isCancellation = patch.status === 'cancelled' || patch.status === 'no-show';
    const isStatusOnlyChange = Object.keys(patch).length === 1 && 'status' in patch;
    if (context.role === 'barber' && existing.staffId !== context.staffId) return error('You can only update appointments assigned to you', 403);
    if (!isCancellation && !isStatusOnlyChange && !['owner', 'admin', 'receptionist'].includes(context.role)) return error('Only the owner, administrator or receptionist can edit appointment details', 403);
    const editsDetails = patch.date || patch.time || patch.serviceId || patch.durationMin || 'staffId' in patch;
    if (editsDetails && !['owner', 'admin', 'receptionist'].includes(currentContext()?.role || '')) return error('Only the owner, administrator or receptionist can edit appointment details', 403);
    if (!canManageClosedAppointments && ['completed', 'cancelled', 'no-show'].includes(existing.status) && (patch.date || patch.time || patch.serviceId || 'staffId' in patch)) return error('Completed or closed appointments can only be edited by the owner or administrator', 409);
    const nextDate = patch.date || existing.date;
    const nextTime = patch.time || existing.time;
    const nextStaffId = 'staffId' in patch ? patch.staffId : existing.staffId;
    const nextDuration = Number(patch.durationMin || existing.durationMin || 30);
    const nextCardNumber = String(patch.cardNumber || existing.cardNumber || '');
    if (nextCardNumber) {
      const { items: appointments } = await db.list('appointments', { limit: 2000 });
      if ((appointments as any[]).some(appointment => appointment.id !== existing.id && !appointment.deletedAt && appointment.date === nextDate && String(appointment.cardNumber || '') === nextCardNumber)) return error('This card number is already assigned on the selected date', 409);
    }
    if (nextStaffId && nextStaffId !== existing.staffId) {
      const [assignedStaff] = await db.get('staff', [patch.staffId]);
      if (!assignedStaff) return error('Staff member not found', 404);
      if (assignedStaff.branchId && existing.branchId && assignedStaff.branchId !== existing.branchId) return error('The employee must belong to the appointment branch', 409);
      if (assignedStaff.employmentStatus === 'laid-off' || !['available', 'in-service'].includes(assignedStaff.status)) return error('That staff member is not available', 409);
      patch.staffName = assignedStaff.name;
      patch.status = existing.status === 'pending' ? 'confirmed' : existing.status;
    }
    if (patch.serviceId) {
      const [service] = await db.get('services', [patch.serviceId]);
      if (!service) return error('Service not found', 404);
    }
    const [ok] = await db.update('appointments', [{ id: params.id, record: { ...existing, ...patch } }]);
    if (patch.staffId) {
      const { items: queueItems } = await db.list('queue', { limit: 2000 });
      const queueEntry = queueItems.find((q: any) => q.appointmentId === params.id);
      if (queueEntry) await db.update('queue', [{ id: queueEntry.id, record: { ...queueEntry, staffId: patch.staffId, staffName: patch.staffName } }]);
    }
    if (!ok) return error('Update failed', 500);
    await audit(patch.staffId ? 'assigned' : `status:${patch.status || 'updated'}`, 'appointment', { ...existing, ...patch }, patch.actor || 'receptionist');
    return json({ ok: true });
  }],
  'GET /api/appointments/:id/completion': [async ({ params }) => {
    requireOwner();
    const { items } = await db.list('orders', { limit: 1000 });
    const order = (items as any[]).find(item => String(item.appointmentId || '') === params.id);
    if (!order) return error('No completed work was found for this appointment', 404);
    return json({ item: order });
  }],
  'POST /api/appointments/:id/reopen': [async ({ params }) => {
    requireOwner();
    const [appointment] = await db.get('appointments', [params.id]);
    if (!appointment || appointment.deletedAt) return error('Appointment not found', 404);
    if (appointment.status !== 'completed') return error('Only completed appointments can be reopened', 409);

    const { items: orders } = await db.list('orders', { limit: 5000 });
    const order = (orders as any[]).find(item => String(item.appointmentId || '') === appointment.id && !item.deletedAt);
    if (order) {
      const { items: payoutItems } = await db.list('payout_items', { limit: 10000 });
      if ((payoutItems as any[]).some(item => !item.deletedAt && item.orderId === order.id)) return error('This deal is already included in a recorded payout and cannot be undone', 409);
    }
    const reopenedAt = Date.now();
    if (order) {
      const productQuantities = new Map<string, number>();
      for (const item of order.items || []) {
        if (item.type === 'product' && item.refId) productQuantities.set(item.refId, (productQuantities.get(item.refId) || 0) + Number(item.qty || 0));
        for (const used of item.consumedProducts || []) if (used.productId) productQuantities.set(used.productId, (productQuantities.get(used.productId) || 0) + Number(used.qty || 0));
      }
      const productIds = [...productQuantities.keys()];
      if (productIds.length) {
        const products = await db.get('products', productIds);
        const productUpdates = products.flatMap((product, index) => product ? [{ id: productIds[index], record: { ...product, stock: Number(product.stock || 0) + (productQuantities.get(productIds[index]) || 0) } }] : []);
        if (productUpdates.length) await db.update('products', productUpdates);
        await db.add('stock_movements', productUpdates.map(update => ({ productId: update.id, productName: update.record.name, change: productQuantities.get(update.id) || 0, reason: `Completed deal reopened: ${appointment.customerName}`, createdAt: reopenedAt, actor: currentContext()?.name || 'owner' })));
      }

      await db.update('orders', [{ id: order.id, record: { ...order, deletedAt: reopenedAt, deletedBy: currentContext()?.name || 'owner', voidReason: 'Owner reopened the linked completed appointment' } }]);
      if (order.customerId) {
        const [customer] = await db.get('customers', [order.customerId]);
        if (customer) {
          const remainingOrders = (orders as any[]).filter(item => !item.deletedAt && item.id !== order.id && item.customerId === customer.id);
          const totalSpent = remainingOrders.reduce((sum, item) => sum + Number(item.totalByCurrency?.KES || 0), 0);
          const totalSpentUSD = remainingOrders.reduce((sum, item) => sum + Number(item.totalByCurrency?.USD || 0), 0);
          const loyaltyPoints = Math.max(0, remainingOrders.reduce((sum, item) => sum + Math.floor(Number(item.totalByCurrency?.KES || 0) / 100) - Number(item.pointsRedeemed || 0), 0));
          const lastVisit = remainingOrders.reduce((latest, item) => Math.max(latest, Number(item.createdAt || 0)), 0) || null;
          await db.update('customers', [{ id: customer.id, record: { ...customer, totalSpent, totalSpentUSD, visits: remainingOrders.length, loyaltyPoints, lastVisit } }]);
        }
      }
    }

    await db.update('appointments', [{ id: appointment.id, record: { ...appointment, status: 'in-service', reopenedAt, reopenedBy: currentContext()?.name || 'owner' } }]);
    const { items: queue } = await db.list('queue', { limit: 2000 });
    const queueEntry = (queue as any[]).find(item => item.appointmentId === appointment.id && !item.deletedAt);
    if (queueEntry) await db.update('queue', [{ id: queueEntry.id, record: { ...queueEntry, status: 'waiting', joinedAt: reopenedAt } }]);
    await audit('reopened completed appointment', 'appointment', { id: appointment.id, customerName: appointment.customerName, orderId: order?.id || null, status: 'in-service' }, currentContext()?.name || 'owner');
    return json({ ok: true, orderVoided: Boolean(order), status: 'in-service' });
  }],
  'DELETE /api/appointments/:id': [async ({ params }) => {
    requireOwner();
    const [appointment] = await db.get('appointments', [params.id]);
    if (!appointment || appointment.deletedAt) return error('Appointment not found', 404);
    const deletedAt = Date.now();
    const deletedBy = currentContext()?.name || 'owner';
    const { items: orders } = await db.list('orders', { limit: 5000 });
    const order = (orders as any[]).find(item => String(item.appointmentId || '') === appointment.id && !item.deletedAt);
    if (order) {
      const { items: payoutItems } = await db.list('payout_items', { limit: 10000 });
      const recordedPayout = (payoutItems as any[]).some(item => !item.deletedAt && item.orderId === order.id);
      const productQuantities = new Map<string, number>();
      for (const item of order.items || []) {
        if (item.type === 'product' && item.refId) productQuantities.set(item.refId, (productQuantities.get(item.refId) || 0) + Number(item.qty || 0));
        for (const used of item.consumedProducts || []) if (used.productId) productQuantities.set(used.productId, (productQuantities.get(used.productId) || 0) + Number(used.qty || 0));
      }
      const productIds = [...productQuantities.keys()];
      if (productIds.length) {
        const products = await db.get('products', productIds);
        const productUpdates = products.flatMap((product, index) => product ? [{ id: productIds[index], record: { ...product, stock: Number(product.stock || 0) + (productQuantities.get(productIds[index]) || 0) } }] : []);
        if (productUpdates.length) await db.update('products', productUpdates);
        await db.add('stock_movements', productUpdates.map(update => ({ productId: update.id, productName: update.record.name, change: productQuantities.get(update.id) || 0, reason: `Deleted appointment: ${appointment.customerName}`, createdAt: deletedAt, actor: deletedBy })));
      }
      await db.update('orders', [{ id: order.id, record: { ...order, deletedAt, deletedBy, voidReason: 'Owner deleted the linked appointment', payoutReversalRequired: recordedPayout } }]);
      if (order.customerId) {
        const [customer] = await db.get('customers', [order.customerId]);
        if (customer) {
          const remainingOrders = (orders as any[]).filter(item => !item.deletedAt && item.id !== order.id && item.customerId === customer.id);
          const totalSpent = remainingOrders.reduce((sum, item) => sum + Number(item.totalByCurrency?.KES || 0), 0);
          const totalSpentUSD = remainingOrders.reduce((sum, item) => sum + Number(item.totalByCurrency?.USD || 0), 0);
          const loyaltyPoints = Math.max(0, remainingOrders.reduce((sum, item) => sum + Math.floor(Number(item.totalByCurrency?.KES || 0) / 100) - Number(item.pointsRedeemed || 0), 0));
          const lastVisit = remainingOrders.reduce((latest, item) => Math.max(latest, Number(item.createdAt || 0)), 0) || null;
          await db.update('customers', [{ id: customer.id, record: { ...customer, totalSpent, totalSpentUSD, visits: remainingOrders.length, loyaltyPoints, lastVisit } }]);
        }
      }
    }
    await db.update('appointments', [{ id: appointment.id, record: { ...appointment, deletedAt, deletedBy } }]);
    const { items: queue } = await db.list('queue', { limit: 2000 });
    const queueEntry = (queue as any[]).find(item => item.appointmentId === appointment.id && !item.deletedAt);
    if (queueEntry) await db.update('queue', [{ id: queueEntry.id, record: { ...queueEntry, deletedAt, deletedBy } }]);
    await audit('deleted appointment', 'appointment', { id: appointment.id, customerName: appointment.customerName, status: appointment.status, queueId: queueEntry?.id || null, orderVoided: Boolean(order), payoutReversalRequired: Boolean(order?.payoutReversalRequired) }, deletedBy);
    return json({ ok: true, orderVoided: Boolean(order) });
  }],
  'DELETE /api/appointments/cancelled': [async () => {
    requireOwner();
    const { items: appointments } = await db.list('appointments', { limit: 5000 });
    const cancelledAppointments = (appointments as any[]).filter(item => item.status === 'cancelled' && !item.deletedAt);
    const cancelledIds = cancelledAppointments.map(item => item.id);
    if (!cancelledIds.length) return json({ deleted: 0 });
    const { items: queue } = await db.list('queue', { limit: 5000 });
    const queueEntries = (queue as any[]).filter(item => cancelledIds.includes(item.appointmentId) && !item.deletedAt);
    const deletedAt = Date.now();
    const deletedBy = currentContext()?.name || 'owner';
    await db.update('appointments', cancelledAppointments.map(item => ({ id: item.id, record: { ...item, deletedAt, deletedBy } })));
    if (queueEntries.length) await db.update('queue', queueEntries.map(item => ({ id: item.id, record: { ...item, deletedAt, deletedBy } })));
    const queueIds = queueEntries.map(item => item.id);
    await audit('deleted cancelled appointments', 'appointments', { appointmentIds: cancelledIds, queueIds }, currentContext()?.name || 'owner');
    return json({ deleted: cancelledIds.length });
  }],

  'GET /api/queue': [async () => { const { items } = await db.list('queue', { limit: 200 }); return json({ items: (items as any[]).filter(item => !item.deletedAt) }); }],
  'POST /api/queue': [async ({ body }) => {
    const b: any = body;
    if (!b.customerName) return error('Customer name is required', 400);
    const { items } = await db.list('queue', { limit: 200 });
    const active = items.filter((q: any) => q.status !== 'completed');
    const position = active.length + 1;
    const ticketNumber = b.ticketNumber || createTicketNumber(new Date().toISOString().slice(0, 10));
    const [id] = await db.add('queue', [{ customerId: b.customerId || null, appointmentId: b.appointmentId || null, customerEmail: b.customerEmail || '', customerName: b.customerName, serviceName: b.serviceName || '', staffId: b.staffId || null, staffName: b.staffName || null, status: 'waiting', joinedAt: Date.now(), position, ticketNumber }]);
    if (!id) return error('Failed to join queue', 500);
    await notifyCustomer(b.customerEmail, `Queue ticket ${ticketNumber}`, `You are now in the SafiGroom queue. Your ticket is ${ticketNumber}.`, id);
    await audit('created', 'queue', { id, customerName: b.customerName, serviceName: b.serviceName || '', staffName: b.staffName || null, ticketNumber }, b.actor || 'receptionist');
    return json({ id, position, ticketNumber });
  }],
  'PUT /api/queue/:id': [async ({ params, body }) => {
    const [existing] = await db.get('queue', [params.id]);
    if (!existing) return error('Queue entry not found', 404);
    const patch: any = body;
    const context = currentContext();
    if (patch.status === 'in-service' || patch.status === 'completed') {
      if (context?.role === 'barber' && existing.staffId !== context.staffId) return error('You can only call or complete clients assigned to you', 403);
      if (!['owner', 'manager', 'admin', 'receptionist', 'barber'].includes(context?.role || '')) return error('You are not allowed to update this queue entry', 403);
    }
    const updated = { ...existing, ...patch, ...(patch.status === 'in-service' ? { calledAt: Date.now() } : {}) };
    const [ok] = await db.update('queue', [{ id: params.id, record: updated }]);
    if (!ok) return error('Update failed', 500);
    if (patch.status === 'in-service') await notifyCustomer(existing.customerEmail, `Now serving ticket ${existing.ticketNumber || ''}`, `Your SafiGroom ticket ${existing.ticketNumber || ''} has been called. Please proceed to ${existing.staffName || 'the assigned employee'}.`, params.id);
    await audit(`status:${patch.status || 'updated'}`, 'queue', updated, patch.actor || existing.staffName || 'staff');
    return json({ ok: true });
  }],
  'DELETE /api/queue/:id': [async () => {
    return error('Records cannot be deleted. Update the queue status to preserve the audit trail.', 405);
  }],

  'GET /api/products': [async () => {
    const { items } = await db.list('products', { limit: 500 });
    return json({ items: (items as any[]).filter(product => !product.archivedAt) });
  }],
  'POST /api/products': [async ({ body }) => {
    const b: any = body;
    if (!b.name) return error('Product name is required', 400);
    const [id] = await db.add('products', [{ name: b.name, category: b.category || 'Other', color: b.color || '', price: b.price || 0, cost: b.cost || 0, stock: b.stock || 0, lowStockThreshold: b.lowStockThreshold ?? 5, unit: b.unit || 'pcs', archivedAt: null }]);
    if (!id) return error('Failed to add product', 500);
    await audit('created', 'product', { id, name: b.name, stock: b.stock || 0, unit: b.unit || 'pcs' }, b.actor || 'owner');
    return json({ id });
  }],
  'PUT /api/products/:id': [async ({ params, body }) => {
    requireOwner();
    const [existing] = await db.get('products', [params.id]);
    if (!existing) return error('Product not found', 404);
    const patch: any = body;
    const updated = { ...existing, ...patch };
    const [ok] = await db.update('products', [{ id: params.id, record: updated }]);
    if (!ok) return error('Update failed', 500);
    if (patch.stock !== undefined && Number(patch.stock) !== Number(existing.stock)) {
      await db.add('stock_movements', [{ productId: params.id, productName: existing.name, previousStock: existing.stock, newStock: patch.stock, change: Number(patch.stock) - Number(existing.stock), reason: patch.reason || 'manual adjustment', createdAt: Date.now(), actor: patch.actor || 'owner' }]);
    }
    await audit('updated', 'product', { ...updated, productName: existing.name }, patch.actor || 'owner');
    return json({ ok: true });
  }],
  'DELETE /api/products/:id': [async ({ params, body }) => {
    requireOwner();
    const [existing] = await db.get('products', [params.id]);
    if (!existing || existing.archivedAt) return error('Product not found', 404);
    const archived = { ...existing, archivedAt: Date.now() };
    const [ok] = await db.update('products', [{ id: params.id, record: archived }]);
    if (!ok) return error('Archive failed', 500);
    await audit('archived', 'product', { id: params.id, productName: existing.name, name: existing.name }, (body as any)?.actor || currentContext()?.name || 'owner');
    return json({ ok: true });
  }],

  'GET /api/orders': [async () => { const { items } = await db.list('orders', { limit: 1000 }); return json({ items: (items as any[]).filter(item => !item.deletedAt) }); }],
  'GET /api/pos-drafts': [async ({ query }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const appointmentId = String(query.appointmentId || '');
    const { items } = await db.list('pos_drafts', { limit: 5000 });
    const draft = (items as any[]).find(item => item.accountId === context.accountId && String(item.appointmentId || '') === appointmentId && String(item.branchId || '') === String(context.branchId || ''));
    return json({ item: draft || null });
  }],
  'POST /api/pos-drafts': [async ({ body }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const draft: any = body;
    if (!Array.isArray(draft.cart) || !draft.cart.length) return error('Add a service or product before saving a draft', 400);
    const appointmentId = String(draft.appointmentId || '');
    const { items } = await db.list('pos_drafts', { limit: 5000 });
    const existing = (items as any[]).filter(item => item.accountId === context.accountId && String(item.appointmentId || '') === appointmentId && String(item.branchId || '') === String(context.branchId || ''));
    if (existing.length) await db.delete('pos_drafts', existing.map(item => item.id));
    const [id] = await db.add('pos_drafts', [{ accountId: context.accountId, appointmentId, cart: draft.cart, customerId: String(draft.customerId || ''), discountPct: Math.max(0, Number(draft.discountPct || 0)), promoCode: String(draft.promoCode || ''), redeemPoints: Math.max(0, Number(draft.redeemPoints || 0)), paymentMethod: String(draft.paymentMethod || 'M-Pesa'), savedAt: Date.now() }]);
    return json({ id });
  }],
  'DELETE /api/pos-drafts': [async ({ query }) => {
    const context = currentContext();
    if (!context) return error('Please log in.', 401);
    const appointmentId = String(query.appointmentId || '');
    const { items } = await db.list('pos_drafts', { limit: 5000 });
    const ids = (items as any[]).filter(item => item.accountId === context.accountId && String(item.appointmentId || '') === appointmentId && String(item.branchId || '') === String(context.branchId || '')).map(item => item.id);
    if (ids.length) await db.delete('pos_drafts', ids);
    return json({ ok: true });
  }],
  'PUT /api/orders/:id/completion': [async ({ params, body }) => {
    requireOwner();
    const [existing] = await db.get('orders', [params.id]);
    if (!existing) return error('Completed work record not found', 404);
    const adjustments = Array.isArray((body as any)?.items) ? (body as any).items : [];
    if (!adjustments.length) return error('Provide at least one completed service adjustment', 400);
    const updatedItems = Array.isArray(existing.items) ? [...existing.items] : [];
    const context = currentContext();
    for (const adjustment of adjustments) {
      const index = Number(adjustment?.index);
      const item = updatedItems[index];
      if (!Number.isInteger(index) || !item || item.type !== 'service') return error('A completed service adjustment is invalid', 400);
      const [staffMember] = await db.get('staff', [String(adjustment.staffId || '')]);
      if (!staffMember) return error('Assigned staff member was not found', 404);
      if (context?.branchId && staffMember.branchId && staffMember.branchId !== context.branchId) return error('Assigned staff must belong to the active branch', 400);
      const helperId = String(adjustment.helperStaffId || '');
      const coStaffId = String(adjustment.coStaffId || '');
      let helper: any = null;
      let coStaff: any = null;
      if (coStaffId) {
        [coStaff] = await db.get('staff', [coStaffId]);
        if (!coStaff) return error('Co-staff member was not found', 404);
        if (context?.branchId && coStaff.branchId && coStaff.branchId !== context.branchId) return error('Co-staff must belong to the active branch', 400);
        if (coStaff.id === staffMember.id) return error('Co-staff must be different from the primary staff member', 400);
      }
      if (helperId) {
        [helper] = await db.get('staff', [helperId]);
        if (!helper) return error('Assistant staff member was not found', 404);
        if (context?.branchId && helper.branchId && helper.branchId !== context.branchId) return error('Assistant must belong to the active branch', 400);
        if (helper.id === staffMember.id || helper.id === coStaff?.id) return error('Assistant must be different from the service staff', 400);
      }
      const rate = Number(adjustment.commissionPct);
      const commissionPct = Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : Number(item.commissionPct || item.commissionRate || 50);
      const serviceRevenue = Number(item.lineTotalAfterDiscount ?? item.price * item.qty) || 0;
      const requestedAssistantPayment = Math.max(0, Number(adjustment.assistantPayment || 0));
      const assistantPayment = helper ? requestedAssistantPayment : 0;
      const productCost = Math.max(0, Number(item.productCost || 0));
      const commissionBase = Math.max(0, serviceRevenue - productCost - assistantPayment);
      const defaultCommission = commissionBase * (commissionPct / 100);
      const hasMultipleStaff = Boolean(coStaff || helper);
      const primaryCommission = hasMultipleStaff ? Math.max(0, Number(adjustment.primaryCommission ?? defaultCommission)) : defaultCommission;
      const coStaffCommission = coStaff ? Math.max(0, Number(adjustment.coStaffCommission ?? defaultCommission)) : 0;
      if (primaryCommission + coStaffCommission > commissionBase) return error('Combined staff commissions cannot exceed the service amount after product and assistant costs', 400);
      updatedItems[index] = { ...item, staffId: staffMember.id, staffName: staffMember.name, coStaffId: coStaff?.id || null, coStaffName: coStaff?.name || null, helperStaffId: helper?.id || null, helperStaffName: helper?.name || null, assistantPayment, helperDeduction: assistantPayment, commissionBase, commissionPct, commissionRate: commissionPct, commission: primaryCommission, primaryCommission, coStaffCommission, commissionParticipants: coStaff ? 2 : 1, commissionSplit: coStaff ? 'manual-two-staff' : 'manual-one-staff' };
    }
    const updated = { ...existing, items: updatedItems, helperDeductions: updatedItems.reduce((sum: number, item: any) => sum + (item.type === 'service' ? Number(item.assistantPayment || 0) : 0), 0) };
    const [ok] = await db.update('orders', [{ id: params.id, record: updated }]);
    if (!ok) return error('Completed work update failed', 500);
    await audit('updated completion', 'order', updated, (body as any)?.actor || context?.name || 'owner');
    return json({ item: updated });
  }],
  'POST /api/orders': [async ({ body }) => {
    const b: any = body;
    const items = b.items;
    if (!items || !Array.isArray(items) || items.length === 0) return error('Cart is empty', 400);

    let effectiveDiscountPct = b.discountPct || 0;
    let discountSource = effectiveDiscountPct > 0 ? 'manual' : 'none';
    let promoUsed: any = null;
    if (b.promoCode) {
      const { items: promos } = await db.list('promotions', { limit: 200 });
      const code = String(b.promoCode).toUpperCase();
      const today = new Date().toISOString().slice(0, 10);
      const match = (promos as any[]).find(p => p.code === code && p.active && p.approved && (!p.startDate || p.startDate <= today) && (!p.endDate || p.endDate >= today));
      if (!match) return error('That promo code is not valid or has expired', 400);
      if (match.discountPct > effectiveDiscountPct) { effectiveDiscountPct = match.discountPct; discountSource = 'promo'; }
      promoUsed = match;
    }
    if (b.customerId) {
      const [custForMembership] = await db.get('customers', [b.customerId]);
      if (custForMembership && custForMembership.membershipTier && custForMembership.membershipTier !== 'none' && (!custForMembership.membershipExpiry || custForMembership.membershipExpiry >= Date.now())) {
        const { items: plans } = await db.list('membership_plans', { limit: 50 });
        const plan = (plans as any[]).find(p => p.name === custForMembership.membershipTier);
        if (plan && plan.discountPct > effectiveDiscountPct) { effectiveDiscountPct = plan.discountPct; discountSource = 'membership'; }
      }
    }
    const discountPct = effectiveDiscountPct;
    const paymentMethod = b.paymentMethod === 'Card' || b.paymentMethod === 'M-Pesa' ? b.paymentMethod : 'Cash';
    const orderItems = items.map((it: any) => ({
      ...it,
      type: it.type || 'service',
      qty: Number(it.qty || 1),
      price: Number(it.price || 0),
      currency: it.currency || 'KES',
      lineTotalAfterDiscount: Math.round((Number(it.price || 0) * Number(it.qty || 0)) * (1 - discountPct / 100)),
    }));
    for (const item of orderItems) {
      if (item.type !== 'product') continue;
      item.staffId = null;
      item.staffName = null;
      item.coStaffId = null;
      item.coStaffName = null;
      item.thirdStaffId = null;
      item.thirdStaffName = null;
      item.thirdStaffCommission = 0;
      item.helperStaffId = null;
      item.helperStaffName = null;
      item.assistantPayment = 0;
      item.helperDeduction = 0;
      item.commissionPct = 0;
      item.commissionRate = 0;
      item.commissionBase = 0;
      item.commission = 0;
      item.consumedProducts = [];
    }
    const context = currentContext();
    const serviceItems = orderItems.filter((it: any) => it.type === 'service');
    for (const item of serviceItems) {
      item.staffCount = serviceStaffCount(item.staffCount);
      if (item.staffCount === 1) {
        item.coStaffId = null;
        item.coStaffName = null;
      } else if (!item.coStaffId) {
        return error('Assign co-staff to services configured for two staff', 400);
      }
    }
    const serviceStaffIds = Array.from(new Set(serviceItems.map((item: any) => String(item.staffId || '')).filter(Boolean)));
    if (serviceItems.some((item: any) => !item.staffId)) return error('Each service must be assigned to a staff member', 400);
    if (context?.role === 'barber' && !serviceItems.some((item: any) => item.staffId === context.staffId)) {
      return error('Include at least one service under your own account when recording this sale', 403);
    }
    if (serviceStaffIds.length) {
      const serviceStaff = await db.get('staff', serviceStaffIds);
      for (let i = 0; i < serviceStaff.length; i++) {
        const member = serviceStaff[i];
        const id = serviceStaffIds[i];
        if (!member) return error('One or more assigned staff records could not be found', 404);
        if (context?.branchId && member.branchId && member.branchId !== context.branchId) return error('Assigned service staff must belong to the active branch', 400);
        if (member.employmentStatus === 'laid-off') return error(`Assigned staff ${member.name} is not active`, 409);
        for (const item of serviceItems) {
          if (item.staffId === id) item.staffName = member.name;
        }
      }
    }
    if (context?.role === 'barber') {
      const today = new Date().toISOString().slice(0, 10);
      const { items: appointments } = await db.list('appointments', { limit: 2000 });
      const servingAppointment = (appointments as any[]).find(item => item.id === b.appointmentId);
      const activeStatuses = ['pending', 'confirmed', 'checked-in', 'in-service'];
      const servingClient = Boolean(b.customerId) && (appointments as any[]).some(item => item.date === today && item.staffId === context.staffId && item.customerId === b.customerId && activeStatuses.includes(item.status));
      const servingAssignedAppointment = Boolean(servingAppointment?.staffId === context.staffId && activeStatuses.includes(servingAppointment.status));
      const { items: queue } = await db.list('queue', { limit: 2000 });
      const queueHandoff = (queue as any[]).some(item => item.staffId === context.staffId
        && ['waiting', 'in-service'].includes(item.status)
        && ((b.appointmentId && item.appointmentId === b.appointmentId) || (b.customerId && item.customerId === b.customerId)));
      if (!servingClient && !servingAssignedAppointment && !queueHandoff) {
        return error('Choose a client currently assigned to you before recording the service', 403);
      }
    }

    const subtotalByCurrency: Record<string, number> = {};
    for (const it of orderItems) {
      const cur = it.currency || 'KES';
      subtotalByCurrency[cur] = (subtotalByCurrency[cur] || 0) + it.price * it.qty;
    }
    const discountByCurrency: Record<string, number> = {};
    const totalByCurrency: Record<string, number> = {};
    for (const cur of Object.keys(subtotalByCurrency)) {
      const d = Math.round(subtotalByCurrency[cur] * (discountPct / 100));
      discountByCurrency[cur] = d;
      totalByCurrency[cur] = subtotalByCurrency[cur] - d;
    }

    let pointsRedeemed = 0;
    if (b.redeemPoints && b.customerId) {
      const [custForPoints] = await db.get('customers', [b.customerId]);
      if (custForPoints) {
        const available = (custForPoints.loyaltyPoints as number) || 0;
        pointsRedeemed = Math.max(0, Math.min(Number(b.redeemPoints) || 0, available, totalByCurrency.KES || 0));
        if (pointsRedeemed > 0) totalByCurrency.KES = (totalByCurrency.KES || 0) - pointsRedeemed;
      }
    }

    for (const item of serviceItems) {
      const coStaffId = item.staffCount === 2 ? String(item.coStaffId || '') : '';
      const thirdStaffId = String(item.thirdStaffId || '');
      const helperId = String(item.helperStaffId || '');
      if (coStaffId) {
        const [coStaff] = await db.get('staff', [coStaffId]);
        if (!coStaff || coStaff.branchId !== context?.branchId) return error('Co-staff must be an employee from the active branch', 400);
        if (coStaff.id === item.staffId) return error('Co-staff must be different from the primary staff member', 400);
        item.coStaffName = coStaff.name;
      }
      if (thirdStaffId) {
        const [thirdStaff] = await db.get('staff', [thirdStaffId]);
        if (!coStaffId) return error('Assign co-staff before adding a third staff member', 400);
        if (!thirdStaff || thirdStaff.branchId !== context?.branchId) return error('Third staff must be an employee from the active branch', 400);
        if (thirdStaff.id === item.staffId || thirdStaff.id === coStaffId) return error('Third staff must be different from the other service staff', 400);
        item.thirdStaffName = thirdStaff.name;
      }
      if (helperId) {
        const [helper] = await db.get('staff', [helperId]);
        if (!helper || helper.branchId !== context?.branchId) return error('Helper must be an employee from the active branch', 400);
        if (helper.id === item.staffId || helper.id === coStaffId || helper.id === thirdStaffId) return error('Assistant must be different from the service staff', 400);
        item.helperStaffName = helper.name;
      }
      const consumedProducts = Array.isArray(item.consumedProducts) ? item.consumedProducts : [];
      item.consumedProducts = consumedProducts
        .map((entry: any) => ({
          productId: String(entry?.productId || entry?.refId || ''),
          name: String(entry?.name || ''),
          qty: Math.max(0, Number(entry?.qty || 0)),
          cost: Math.max(0, Number(entry?.cost || 0)),
          unit: String(entry?.unit || ''),
        }))
        .filter((entry: any) => entry.productId && entry.qty > 0);
      item.assistantPayment = 0;
      item.helperDeduction = 0;
    }

    const productItems = orderItems.filter((it: any) => it.type === 'product');
    const productQuantities = new Map<string, number>();
    for (const item of productItems) {
      productQuantities.set(item.refId, (productQuantities.get(item.refId) || 0) + Number(item.qty || 0));
    }
    for (const item of serviceItems) {
      for (const used of item.consumedProducts || []) {
        productQuantities.set(used.productId, (productQuantities.get(used.productId) || 0) + Number(used.qty || 0));
      }
    }
    const productIds = Array.from(productQuantities.keys());
    if (productIds.length) {
      const products = await db.get('products', productIds);
      const updates: any[] = [];
      const byId = new Map<string, any>();
      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const id = productIds[i];
        const quantity = productQuantities.get(id) || 0;
        if (!p) return error('One or more products could not be found', 404);
        if (Number(p.stock || 0) < quantity) return error(`${p.name} has only ${p.stock} ${p.unit} in stock`, 409);
        byId.set(id, p);
        updates.push({ id, record: { ...p, stock: Number(p.stock || 0) - quantity } });
      }
      for (const item of productItems) {
        const product = byId.get(item.refId);
        if (product) item.cost = Number(product.cost || 0);
      }
      for (const item of serviceItems) {
        item.consumedProducts = (item.consumedProducts || []).map((used: any) => {
          const product = byId.get(used.productId);
          return {
            ...used,
            name: product?.name || used.name,
            cost: Number(product?.cost || used.cost || 0),
            unit: product?.unit || used.unit || '',
          };
        });
        item.assistantPayment = item.helperStaffId ? assistantCompensation(Number(item.price || 0) * Number(item.qty || 1), hasSpecialAssistantBraid(item)) : 0;
        item.helperDeduction = item.assistantPayment;
      }
      if (updates.length) await db.update('products', updates);
      const productMoves = productItems.map((item: any) => ({
        productId: item.refId,
        productName: item.name,
        change: -Number(item.qty || 0),
        reason: 'POS sale',
        orderCustomerName: b.customerName || 'Walk-in Customer',
        createdAt: Date.now(),
        actor: b.actor || 'receptionist',
      }));
      const usedMoves = serviceItems.flatMap((item: any) => (item.consumedProducts || []).map((used: any) => ({
        productId: used.productId,
        productName: used.name,
        change: -Number(used.qty || 0),
        reason: `Service usage: ${item.name}`,
        orderCustomerName: b.customerName || 'Walk-in Customer',
        createdAt: Date.now(),
        actor: b.actor || item.staffName || 'staff',
      })));
      const movementEntries = [...productMoves, ...usedMoves].filter(move => Number(move.change) !== 0);
      if (movementEntries.length) await db.add('stock_movements', movementEntries);
    }

    const helperDeductions = serviceItems.reduce((sum: number, item: any) => sum + Number(item.assistantPayment || 0), 0);
    const productSalesCostTotal = productItems.reduce((sum: number, item: any) => sum + Math.max(0, Number(item.cost || 0)) * Number(item.qty || 0), 0);
    const serviceProductCostTotal = serviceItems.reduce((sum: number, item: any) => sum + (item.consumedProducts || []).reduce((inner: number, used: any) => inner + Math.max(0, Number(used.cost || 0)) * Math.max(0, Number(used.qty || 0)), 0), 0);
    const productCostTotal = productSalesCostTotal + serviceProductCostTotal;
    for (const item of serviceItems) {
      item.productCost = (item.consumedProducts || []).reduce((sum: number, used: any) => sum + Math.max(0, Number(used.cost || 0)) * Math.max(0, Number(used.qty || 0)), 0);
      item.commissionBase = Math.max(0, Number(item.lineTotalAfterDiscount || 0) - Number(item.productCost || 0));
      item.commissionBase = Math.max(0, item.commissionBase - Number(item.helperDeduction || 0));
      item.commissionRate = commissionPct(item.commissionPct, item.staffCount);
      item.commissionPct = item.commissionRate;
      const defaultCommission = item.commissionBase * (item.commissionRate / 100);
      const hasMultipleStaff = Boolean(item.coStaffId || item.thirdStaffId || item.helperStaffId);
      item.primaryCommission = hasMultipleStaff ? Math.max(0, Number(item.primaryCommission ?? defaultCommission)) : defaultCommission;
      item.coStaffCommission = item.coStaffId ? Math.max(0, Number(item.coStaffCommission ?? defaultCommission)) : 0;
      item.thirdStaffCommission = item.thirdStaffId ? Math.max(0, Number(item.thirdStaffCommission ?? 0)) : 0;
      if (item.primaryCommission + item.coStaffCommission + item.thirdStaffCommission > item.commissionBase) return error(`Staff commissions for ${item.name} cannot exceed the service balance after product and assistant costs`, 400);
      item.commission = item.primaryCommission;
      item.commissionParticipants = item.thirdStaffId ? 3 : item.staffCount;
      item.commissionSplit = item.thirdStaffId ? 'manual-three-staff' : item.coStaffId ? 'manual-two-staff' : 'manual-one-staff';
    }

    let customerName = b.customerName || 'Walk-in Customer';
    if (b.customerId) {
      const [cust] = await db.get('customers', [b.customerId]);
      if (cust) {
        customerName = cust.name as string;
        const kesTotal = totalByCurrency.KES || 0;
        const usdTotal = totalByCurrency.USD || 0;
        const points = Math.floor(kesTotal / 100);
        await db.update('customers', [{ id: b.customerId, record: { ...cust, totalSpent: (cust.totalSpent as number || 0) + kesTotal, totalSpentUSD: (cust.totalSpentUSD as number || 0) + usdTotal, visits: (cust.visits as number || 0) + 1, loyaltyPoints: (cust.loyaltyPoints as number || 0) + points - pointsRedeemed, lastVisit: Date.now() } }]);
      }
    }

    const [orderId] = await db.add('orders', [{ customerId: b.customerId || null, customerName, appointmentId: b.appointmentId || null, items: orderItems, helperDeductions, productCostTotal, commissionRate: 50, branchId: context?.branchId || null, branchName: context?.branchId || null, discountPct, discountSource, promoCode: promoUsed ? promoUsed.code : null, pointsRedeemed, mpesaReceiptNumber: b.mpesaReceiptNumber || null, subtotalByCurrency, discountByCurrency, totalByCurrency, paymentMethod, createdAt: Date.now() }]);
    if (!orderId) return error('Failed to create order', 500);
    await audit('created', 'order', { id: orderId, customerName, items: orderItems.map((item: any) => ({ ...item, productName: item.type === 'product' ? item.name : undefined, serviceName: item.type === 'service' ? item.name : undefined })), totalByCurrency, paymentMethod }, b.actor || 'receptionist');

    if (b.appointmentId) {
      const [appt] = await db.get('appointments', [b.appointmentId]);
      if (context?.role === 'barber' && appt?.staffId !== context.staffId) return error('You can only complete clients assigned to you', 403);
      if (appt) await db.update('appointments', [{ id: b.appointmentId, record: { ...appt, status: 'completed' } }]);
    }

    return json({ id: orderId, subtotalByCurrency, discountByCurrency, totalByCurrency, discountSource, pointsRedeemed });
  }],

  'GET /api/expenses': [async () => { const { items } = await db.list('expenses', { limit: 500 }); return json({ items }); }],
  'POST /api/expenses': [async ({ body }) => {
    const b: any = body;
    if (!b.category || !b.amount) return error('Category and amount are required', 400);
    const [id] = await db.add('expenses', [{ category: b.category, amount: b.amount, note: b.note || '', date: b.date || new Date().toISOString().slice(0, 10) }]);
    if (!id) return error('Failed to record expense', 500);
    await audit('created', 'expense', { id, category: b.category, amount: b.amount, note: b.note || '', date: b.date || new Date().toISOString().slice(0, 10) }, b.actor || 'receptionist');
    return json({ id });
  }],
  'GET /api/payouts': [async () => {
    if (!['owner', 'admin'].includes(currentContext()?.role || '')) return error('Only the owner or administrator can view payouts', 403);
    const { items } = await db.list('payout_batches', { limit: 100 });
    return json({ items: (items as any[]).sort((a, b) => b.createdAt - a.createdAt) });
  }],
  'GET /api/payroll/staff': [async () => {
    const context = currentContext();
    if (!context || !['owner', 'admin'].includes(context.role)) return error('Only the owner or administrator can view payroll staff', 403);
    const { items } = await db.list('staff', { limit: 2000 });
    const from = Date.now() - 14 * DAY;
    const { items: orders } = await db.list('orders', { limit: 5000 });
    const totals = new Map<string, { commission: number; assistant: number }>();
    for (const order of orders as any[]) {
      if (order.deletedAt) continue;
      if (!order.createdAt || order.createdAt < from) continue;
      for (const item of order.items || []) {
        if (item.type !== 'service') continue;
        if (item.staffId) {
          const total = totals.get(item.staffId) || { commission: 0, assistant: 0 };
          total.commission += staffCommission(item, item.staffId);
          totals.set(item.staffId, total);
        }
        if (item.coStaffId) {
          const total = totals.get(item.coStaffId) || { commission: 0, assistant: 0 };
          total.commission += staffCommission(item, item.coStaffId);
          totals.set(item.coStaffId, total);
        }
        if (item.thirdStaffId) {
          const total = totals.get(item.thirdStaffId) || { commission: 0, assistant: 0 };
          total.commission += staffCommission(item, item.thirdStaffId);
          totals.set(item.thirdStaffId, total);
        }
        if (item.helperStaffId) {
          const total = totals.get(item.helperStaffId) || { commission: 0, assistant: 0 };
          total.assistant += Number(item.assistantPayment ?? item.helperDeduction ?? 0);
          totals.set(item.helperStaffId, total);
        }
      }
    }
    return json({ items: (items as any[]).map(member => ({ ...member, commissionEarned14Days: totals.get(member.id)?.commission || 0, assistantEarned14Days: totals.get(member.id)?.assistant || 0 })) });
  }],
  'POST /api/payouts': [async ({ body }) => {
    const context = currentContext();
    if (!context || !['owner', 'admin'].includes(context.role)) return error('Only the owner or administrator can record payouts', 403);
    const range = body?.range === 'today' || body?.range === 'week' || body?.range === 'fortnight' || body?.range === 'month' || body?.range === 'all' ? body.range : 'fortnight';
    const now = Date.now();
    let from = 0;
    if (range === 'today') { const day = new Date(); day.setHours(0, 0, 0, 0); from = day.getTime(); }
    if (range === 'week') from = now - 7 * DAY;
    if (range === 'fortnight') from = now - 14 * DAY;
    if (range === 'month') from = now - 30 * DAY;

    const [{ items: orders }, { items: staff }, { items: paidItems }] = await Promise.all([
      db.list('orders', { limit: 5000 }),
      db.list('staff', { limit: 2000 }),
      db.list('payout_items', { limit: 10000 }),
    ]);
    const staffById = new Map((staff as any[]).map(member => [member.id, member]));
    const alreadyPaid = new Set((paidItems as any[]).map(item => item.itemKey));
    const lines: any[] = [];
    for (const order of orders as any[]) {
      if (order.deletedAt) continue;
      if (!order.createdAt || order.createdAt < from || order.createdAt >= now) continue;
      (order.items || []).forEach((item: any, index: number) => {
        if (item.type !== 'service' || !item.staffId) return;
        const member = staffById.get(item.staffId);
        if (!member) return;
        const revenue = Number(item.lineTotalAfterDiscount ?? item.price * item.qty) || 0;
        const commissionBase = Math.max(0, Number(item.commissionBase ?? (revenue - Number(item.productCost || 0) - Number(item.assistantPayment ?? item.helperDeduction ?? 0))) || 0);
        const commission = serviceCommission(item);
        if (!alreadyPaid.has(`${order.id}:${index}`)) lines.push({ itemKey: `${order.id}:${index}`, orderId: order.id, staffId: item.staffId, staffName: item.staffName || member.name, revenue, commissionBase, helperDeduction: Number(item.helperDeduction || 0), productCost: Number(item.productCost || 0), commission, currency: item.currency || 'KES', branchId: order.branchId || context.branchId || null, createdAt: now });
        if (item.coStaffId && !alreadyPaid.has(`${order.id}:${index}:co-staff`)) {
          const coStaff = staffById.get(item.coStaffId);
          if (coStaff) lines.push({ itemKey: `${order.id}:${index}:co-staff`, orderId: order.id, staffId: item.coStaffId, staffName: item.coStaffName || coStaff.name, revenue, commissionBase, helperDeduction: Number(item.helperDeduction || 0), productCost: Number(item.productCost || 0), commission, currency: item.currency || 'KES', branchId: order.branchId || context.branchId || null, createdAt: now, role: 'co-staff' });
        }
        if (item.thirdStaffId && !alreadyPaid.has(`${order.id}:${index}:third-staff`)) {
          const thirdStaff = staffById.get(item.thirdStaffId);
          const thirdStaffCommission = staffCommission(item, item.thirdStaffId);
          if (thirdStaff) lines.push({ itemKey: `${order.id}:${index}:third-staff`, orderId: order.id, staffId: item.thirdStaffId, staffName: item.thirdStaffName || thirdStaff.name, revenue, commissionBase, helperDeduction: Number(item.helperDeduction || 0), productCost: Number(item.productCost || 0), commission: thirdStaffCommission, currency: item.currency || 'KES', branchId: order.branchId || context.branchId || null, createdAt: now, role: 'third-staff' });
        }
        if (item.helperStaffId && !alreadyPaid.has(`${order.id}:${index}:assistant`)) {
          const assistant = staffById.get(item.helperStaffId);
          if (assistant) lines.push({ itemKey: `${order.id}:${index}:assistant`, orderId: order.id, staffId: item.helperStaffId, staffName: item.helperStaffName || assistant.name, revenue: 0, commissionBase: 0, helperDeduction: 0, productCost: 0, commission: Number(item.assistantPayment ?? item.helperDeduction ?? 0), currency: item.currency || 'KES', branchId: order.branchId || context.branchId || null, createdAt: now, role: 'assistant' });
        }
      });
    }
    if (!lines.length) return error('There are no unpaid commissions in this period.', 409);
    const totalKES = lines.filter(line => line.currency === 'KES').reduce((sum, line) => sum + line.commission, 0);
    const [batchId] = await db.add('payout_batches', [{ range, from, to: now, totalKES, employeeCount: new Set(lines.map(line => line.staffId)).size, itemCount: lines.length, status: 'recorded', createdAt: now }]);
    await db.add('payout_items', lines.map(line => ({ ...line, batchId })));
    await audit('recorded', 'payout_batch', { id: batchId, range, totalKES, employeeCount: new Set(lines.map(line => line.staffId)).size, itemCount: lines.length }, 'owner');
    return json({ id: batchId, range, totalKES, employeeCount: new Set(lines.map(line => line.staffId)).size, itemCount: lines.length, status: 'recorded', message: 'Payout recorded internally. No money was sent.' });
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
        const response = await fetch(`${baseUrl}/mpesa/b2c/v1/paymentrequest`, { method: 'POST', headers: { Authorization: `Bearer ${tokenBody.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ InitiatorName: initiator, SecurityCredential: securityCredential, CommandID: process.env.MPESA_B2C_COMMAND_ID || 'BusinessPayment', Amount: recipient.amountKES, PartyA: shortcode, PartyB: recipient.phone, Remarks: `SafiGroom payroll ${batchId}`, QueueTimeOutURL: timeoutUrl, ResultURL: resultUrl, Occasion: 'Payroll' }) });
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

  'GET /api/dashboard': [async ({ query }) => {
    const range = query.range || 'today';
    const now = Date.now();
    let cutoff = 0;
    if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); cutoff = d.getTime(); }
    else if (range === 'week') cutoff = now - 7 * DAY;
    else if (range === 'month') cutoff = now - 30 * DAY;
    else cutoff = 0;

    const [ordersResult, expensesResult, staffResult, productsResult, appointmentsResult, queueResult, customersResult] = await Promise.all([
      db.list('orders', { limit: 1000 }),
      db.list('expenses', { limit: 500 }),
      db.list('staff', { limit: 200 }),
      db.list('products', { limit: 500 }),
      db.list('appointments', { limit: 1000 }),
      db.list('queue', { limit: 200 }),
      db.list('customers', { limit: 5000 }),
    ]);
    const orders = ordersResult.items;
    const expensesAll = expensesResult.items;
    const staffAll = staffResult.items;
    const productsAll = productsResult.items;
    const appts = (appointmentsResult.items as any[]).filter(item => !item.deletedAt);
    const queueAll = (queueResult.items as any[]).filter(item => !item.deletedAt);
    const customersAll = customersResult.items;

    const staffById = new Map(staffAll.map((s: any) => [s.id, s]));
    const productById = new Map(productsAll.map((p: any) => [p.id, p]));

    const rangeOrders = (orders as any[]).filter(o => !o.deletedAt && o.createdAt >= cutoff);
    const paymentMethodTotals: Record<'Cash' | 'Card' | 'M-Pesa', number> = { Cash: 0, Card: 0, 'M-Pesa': 0 };
    const revenueByCurrency: Record<string, number> = {};
    for (const o of rangeOrders) {
      const totals = o.totalByCurrency || (typeof o.total === 'number' ? { KES: o.total } : {});
      for (const cur of Object.keys(totals)) revenueByCurrency[cur] = (revenueByCurrency[cur] || 0) + totals[cur];
      const method = o.paymentMethod === 'Card' || o.paymentMethod === 'M-Pesa' ? o.paymentMethod : 'Cash';
      paymentMethodTotals[method as 'Cash' | 'Card' | 'M-Pesa'] += Number(totals.KES || 0);
    }

    let productCost = 0;
    const commissionsByCurrency: Record<string, number> = {};
    const staffRevenue = new Map<string, { name: string; currency: string; revenue: number; commission: number; helperDeductions: number; count: number }>();
    const serviceRevenue = new Map<string, { name: string; currency: string; revenue: number; count: number }>();
    const commissionByClient: any[] = [];
    for (const o of rangeOrders) {
      for (const it of (o.items || [])) {
        const cur = it.currency || 'KES';
        if (it.type === 'product') {
          const p: any = productById.get(it.refId);
          if (p) productCost += (p.cost || 0) * it.qty;
        } else if (it.type === 'service') {
          const staff: any = it.staffId ? staffById.get(it.staffId) : null;
          const serviceRevenueAfterDiscount = it.lineTotalAfterDiscount ?? it.price * it.qty;
          const comm = staffCommission(it, it.staffId);
          const assistantAmount = Number(it.assistantPayment ?? it.helperDeduction ?? 0);
          commissionsByCurrency[cur] = (commissionsByCurrency[cur] || 0) + comm;
          if (it.staffId) {
            const key = `${it.staffId}|${cur}`;
            const entry = staffRevenue.get(key) || { name: it.staffName || 'Unknown', currency: cur, revenue: 0, commission: 0, helperDeductions: 0, count: 0 };
            entry.revenue += serviceRevenueAfterDiscount; entry.commission += comm; entry.helperDeductions += assistantAmount; entry.count += it.qty;
            staffRevenue.set(key, entry);
            commissionByClient.push({ clientId: o.customerId || null, clientName: o.customerName || 'Walk-in Customer', staffName: it.staffName || staff.name, serviceName: it.name, revenue: serviceRevenueAfterDiscount, assistantPayment: assistantAmount, commission: comm, currency: cur, createdAt: o.createdAt });
          }
          if (it.coStaffId) {
            const coStaff: any = staffById.get(it.coStaffId);
            const coStaffCommission = staffCommission(it, it.coStaffId);
            commissionsByCurrency[cur] = (commissionsByCurrency[cur] || 0) + coStaffCommission;
            const key = `${it.coStaffId}|${cur}`;
            const entry = staffRevenue.get(key) || { name: it.coStaffName || coStaff?.name || 'Unknown', currency: cur, revenue: 0, commission: 0, helperDeductions: 0, count: 0 };
            entry.revenue += serviceRevenueAfterDiscount; entry.commission += coStaffCommission; entry.count += it.qty;
            staffRevenue.set(key, entry);
            commissionByClient.push({ clientId: o.customerId || null, clientName: o.customerName || 'Walk-in Customer', staffName: it.coStaffName || coStaff?.name || 'Unknown', serviceName: it.name, revenue: serviceRevenueAfterDiscount, assistantPayment: 0, commission: coStaffCommission, currency: cur, createdAt: o.createdAt });
          }
          if (it.thirdStaffId) {
            const thirdStaff: any = staffById.get(it.thirdStaffId);
            const thirdStaffCommission = staffCommission(it, it.thirdStaffId);
            commissionsByCurrency[cur] = (commissionsByCurrency[cur] || 0) + thirdStaffCommission;
            const key = `${it.thirdStaffId}|${cur}`;
            const entry = staffRevenue.get(key) || { name: it.thirdStaffName || thirdStaff?.name || 'Unknown', currency: cur, revenue: 0, commission: 0, helperDeductions: 0, count: 0 };
            entry.revenue += serviceRevenueAfterDiscount; entry.commission += thirdStaffCommission; entry.count += it.qty;
            staffRevenue.set(key, entry);
            commissionByClient.push({ clientId: o.customerId || null, clientName: o.customerName || 'Walk-in Customer', staffName: it.thirdStaffName || thirdStaff?.name || 'Unknown', serviceName: it.name, revenue: serviceRevenueAfterDiscount, assistantPayment: 0, commission: thirdStaffCommission, currency: cur, createdAt: o.createdAt });
          }
          const skey = `${it.name}|${cur}`;
          const s = serviceRevenue.get(skey) || { name: it.name, currency: cur, revenue: 0, count: 0 };
          s.revenue += serviceRevenueAfterDiscount; s.count += it.qty;
          serviceRevenue.set(skey, s);
        }
      }
    }

    const rangeExpenses = (expensesAll as any[]).filter(e => new Date(e.date).getTime() >= cutoff);
    const expenseTotal = rangeExpenses.reduce((s: number, e: any) => s + e.amount, 0);
    const estimatedProfitByCurrency: Record<string, number> = {};
    estimatedProfitByCurrency.KES = (revenueByCurrency.KES || 0) - productCost - (commissionsByCurrency.KES || 0) - expenseTotal;
    if (revenueByCurrency.USD || commissionsByCurrency.USD) {
      estimatedProfitByCurrency.USD = (revenueByCurrency.USD || 0) - (commissionsByCurrency.USD || 0);
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const todaysAppointments = (appts as any[]).filter(a => a.date === todayStr);
    const lowStock = (productsAll as any[]).filter(p => p.stock <= p.lowStockThreshold);
    const activeStaff = (staffAll as any[]).filter(s => s.status === 'available' || s.status === 'in-service');
    const waitingQueue = (queueAll as any[]).filter(q => q.status === 'waiting');

    const trend: { date: string; revenue: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const start = d.getTime(); const end = start + DAY;
      const dayTotal = (orders as any[]).filter(o => o.createdAt >= start && o.createdAt < end).reduce((s, o) => s + ((o.totalByCurrency && o.totalByCurrency.KES) ?? (typeof o.total === 'number' ? o.total : 0)), 0);
      trend.push({ date: d.toISOString().slice(0, 10), revenue: dayTotal });
    }

    return json({
      range, revenueByCurrency, ordersCount: rangeOrders.length, paymentMethodTotals,
      expenseTotal, productCost, commissionsByCurrency, estimatedProfitByCurrency,
      todaysAppointmentsCount: todaysAppointments.length,
      upcomingAppointments: todaysAppointments.filter((a: any) => ['pending', 'confirmed', 'checked-in'].includes(a.status)).slice(0, 8),
      lowStockProducts: lowStock,
      activeStaffCount: activeStaff.length, totalStaffCount: staffAll.length,
      waitingQueueCount: waitingQueue.length,
      customersCount: customersAll.length,
      customers: customersAll.slice(0, 10),
      commissionByClient,
      topStaff: Array.from(staffRevenue.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 8),
      topServices: Array.from(serviceRevenue.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 8),
      trend,
    });
  }],

  'GET /api/analytics/rebooking': [async () => {
    const [ordersResult, customersResult] = await Promise.all([
      db.list('orders', { limit: 1000 }),
      db.list('customers', { limit: 1000 }),
    ]);
    const orders = ordersResult.items;
    const customers = customersResult.items;
    const byCustomer = new Map<string, number[]>();
    for (const o of orders as any[]) {
      if (!o.customerId) continue;
      const arr = byCustomer.get(o.customerId) || [];
      arr.push(o.createdAt);
      byCustomer.set(o.customerId, arr);
    }
    const results: any[] = [];
    for (const c of customers as any[]) {
      const dates = (byCustomer.get(c.id) || []).sort((a, b) => a - b);
      if (dates.length < 2) continue;
      let gaps = 0;
      for (let i = 1; i < dates.length; i++) gaps += dates[i] - dates[i - 1];
      const avgGap = gaps / (dates.length - 1);
      const last = dates[dates.length - 1];
      const predicted = last + avgGap;
      const daysUntil = Math.round((predicted - Date.now()) / DAY);
      if (daysUntil <= 7) {
        results.push({ customerId: c.id, customerName: c.name, avgIntervalDays: Math.round(avgGap / DAY), predictedDate: new Date(predicted).toISOString().slice(0, 10), daysUntil, lastVisit: new Date(last).toISOString().slice(0, 10) });
      }
    }
    results.sort((a, b) => a.daysUntil - b.daysUntil);
    return json({ items: results });
  }],

  'POST /api/ai/ask': [async ({ body }) => {
    const q = (((body as any)?.question) || '').toLowerCase().trim();
    if (!q) return error('Question is required', 400);
    const { items: orders } = await db.list('orders', { limit: 1000 });
    const { items: staffAll } = await db.list('staff', { limit: 200 });
    const { items: productsAll } = await db.list('products', { limit: 500 });
    const { items: customersAll } = await db.list('customers', { limit: 1000 });

    const now = Date.now();
    const monthAgo = now - 30 * DAY;
    const weekAgo = now - 7 * DAY;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    const sumRange = (cutoff: number) => {
      const res: Record<string, number> = {};
      for (const o of orders as any[]) {
        if (o.createdAt >= cutoff) {
          const t = o.totalByCurrency || (typeof o.total === 'number' ? { KES: o.total } : {});
          for (const c of Object.keys(t)) res[c] = (res[c] || 0) + t[c];
        }
      }
      return res;
    };

    if (q.includes('revenue') || q.includes('sales') || q.includes('earn')) {
      let cutoff = monthAgo; let label = 'this month (last 30 days)';
      if (q.includes('today')) { cutoff = todayStart.getTime(); label = 'today'; }
      else if (q.includes('week')) { cutoff = weekAgo; label = 'this week'; }
      const totals = sumRange(cutoff);
      const count = (orders as any[]).filter(o => o.createdAt >= cutoff).length;
      const parts = Object.entries(totals).map(([c, v]) => c === 'USD' ? `$${(v as number).toFixed(2)}` : `KES ${Math.round(v as number).toLocaleString()}`);
      const text = parts.length ? parts.join(' and ') : 'KES 0';
      return json({ answer: `Revenue ${label} is ${text} across ${count} transaction${count === 1 ? '' : 's'}. This is computed directly from your recorded orders.`, grounded: true });
    }

    if (q.includes('top') && (q.includes('staff') || q.includes('barber') || q.includes('stylist'))) {
      const kesMap = new Map<string, number>(); const usdMap = new Map<string, number>();
      for (const o of orders as any[]) for (const it of (o.items || [])) if (it.type === 'service' && it.staffId) {
        const m = it.currency === 'USD' ? usdMap : kesMap;
        m.set(it.staffName, (m.get(it.staffName) || 0) + it.price * it.qty);
      }
      const kesSorted = Array.from(kesMap.entries()).sort((a, b) => b[1] - a[1]);
      const usdSorted = Array.from(usdMap.entries()).sort((a, b) => b[1] - a[1]);
      if (kesSorted.length === 0 && usdSorted.length === 0) return json({ answer: 'No completed sales with staff assigned yet, so I cannot determine a top performer.', grounded: true });
      const bits: string[] = [];
      if (kesSorted.length) bits.push(`${kesSorted[0][0]} leads KES sales with KES ${Math.round(kesSorted[0][1]).toLocaleString()}`);
      if (usdSorted.length) bits.push(`${usdSorted[0][0]} leads USD sales with $${usdSorted[0][1].toFixed(2)}`);
      return json({ answer: bits.join('; ') + '.', grounded: true });
    }

    if (q.includes('low stock') || q.includes('run out') || q.includes('restock') || q.includes('inventory')) {
      const low = (productsAll as any[]).filter(p => p.stock <= p.lowStockThreshold);
      if (low.length === 0) return json({ answer: 'No products are currently below their low-stock threshold.', grounded: true });
      const list = low.map(p => `${p.name} (${p.stock} ${p.unit} left, threshold ${p.lowStockThreshold})`).join(', ');
      return json({ answer: `${low.length} product${low.length === 1 ? '' : 's'} at or below the reorder threshold: ${list}.`, grounded: true });
    }

    if (q.includes('inactive') || (q.includes('customer') && (q.includes("haven't") || q.includes('not visited') || q.includes('havent')))) {
      const match = q.match(/(\d+)\s*day/);
      const days = match ? parseInt(match[1], 10) : 60;
      const cutoff = now - days * DAY;
      const inactive = (customersAll as any[]).filter(c => c.lastVisit && c.lastVisit < cutoff);
      if (inactive.length === 0) return json({ answer: `No customers with a recorded visit are inactive for more than ${days} days.`, grounded: true });
      const names = inactive.slice(0, 10).map(c => c.name).join(', ');
      return json({ answer: `${inactive.length} customer${inactive.length === 1 ? '' : 's'} haven't visited in over ${days} days: ${names}${inactive.length > 10 ? ', and others' : ''}.`, grounded: true });
    }

    if (q.includes('busiest') || q.includes('busy hour')) {
      const hourCounts = new Array(24).fill(0);
      for (const o of orders as any[]) hourCounts[new Date(o.createdAt).getHours()]++;
      const maxCount = Math.max(...hourCounts);
      if (maxCount === 0) return json({ answer: 'Not enough transaction history yet to determine peak hours.', grounded: true });
      const maxHour = hourCounts.indexOf(maxCount);
      return json({ answer: `Based on recorded transactions, your busiest hour is around ${maxHour}:00\u2013${maxHour + 1}:00.`, grounded: true });
    }

    if (q.includes('staff') && q.includes('commission')) {
      const kesMap = new Map<string, number>(); const usdMap = new Map<string, number>();
      for (const o of orders as any[]) for (const it of (o.items || [])) {
        if (it.type === 'service' && it.staffId) {
          const staff: any = (staffAll as any[]).find(s => s.id === it.staffId);
          const pct = staff ? 40 : 0;
          const m = it.currency === 'USD' ? usdMap : kesMap;
          m.set(it.staffName, (m.get(it.staffName) || 0) + it.price * it.qty * (pct / 100));
        }
      }
      const kesLines = Array.from(kesMap.entries()).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}: KES ${Math.round(c).toLocaleString()}`).join('; ');
      const usdLines = Array.from(usdMap.entries()).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}: $${c.toFixed(2)}`).join('; ');
      const parts = [kesLines, usdLines].filter(Boolean);
      return json({ answer: parts.length ? `Commission earned by staff (all recorded orders) \u2014 ${parts.join(' | ')}.` : 'No commission-generating sales recorded yet.', grounded: true });
    }

    if (q.includes('salary') || q.includes('salaries') || q.includes('payroll')) {
      return json({ answer: 'SafiGroom has no salary payroll. Employees are paid 50% of service revenue after product cost and helper deductions.', grounded: true });
    }

    return json({ answer: "I can only answer from your actual recorded data right now \u2014 try asking about revenue (today/this week/this month), top staff, low stock, inactive customers, busiest hours, staff commissions, or expenses.", grounded: false });
  }],

  'GET /api/messages': [async ({ query }) => {
    const channel = query.channel || 'team';
    const { items } = await db.list('messages', { limit: 500 });
    const filtered = (items as any[]).filter(m => m.channel === channel).sort((a, b) => a.createdAt - b.createdAt);
    return json({ items: filtered });
  }],
  'POST /api/messages': [async () => {
    return error('Communication is email-only. Use email notifications or promotion campaigns.', 410);
  }],

  'GET /api/memberships': [async () => { const { items } = await db.list('membership_plans', { limit: 50 }); return json({ items }); }],
  'POST /api/memberships': [async ({ body }) => {
    const b: any = body;
    if (!b.name) return error('Plan name is required', 400);
    const [id] = await db.add('membership_plans', [{ name: b.name, discountPct: b.discountPct || 0, priceKES: b.priceKES || 0, durationDays: b.durationDays || 30, benefits: b.benefits || [] }]);
    if (!id) return error('Failed to add membership plan', 500);
    await audit('created', 'membership_plan', { id, name: b.name, discountPct: b.discountPct || 0 }, b.actor || 'owner');
    return json({ id });
  }],
  'POST /api/memberships/purchase': [async ({ body }) => {
    const b: any = body;
    const [customer] = await db.get('customers', [b.customerId]);
    const [plan] = await db.get('membership_plans', [b.planId]);
    if (!customer || !plan) return error('Customer or membership plan not found', 404);
    if (!b.mpesaReceiptNumber) return error('Membership payment must be completed first', 402);
    const now = Date.now();
    const expiry = now + Number(plan.durationDays || 30) * DAY;
    const [purchaseId] = await db.add('membership_purchases', [{ customerId: customer.id, customerName: customer.name, planId: plan.id, planName: plan.name, amountKES: plan.priceKES, mpesaReceiptNumber: b.mpesaReceiptNumber, purchasedAt: now, expiresAt: expiry }]);
    await db.update('customers', [{ id: customer.id, record: { ...customer, membershipTier: plan.name, membershipPlanId: plan.id, membershipExpiry: expiry } }]);
    await audit('purchased', 'membership', { id: purchaseId, customerId: customer.id, customerName: customer.name, planName: plan.name, amountKES: plan.priceKES }, 'customer');
    return json({ purchaseId, membershipTier: plan.name, membershipExpiry: expiry });
  }],

  'GET /api/promotions': [async () => { const { items } = await db.list('promotions', { limit: 200 }); return json({ items }); }],
  'POST /api/promotions': [async ({ body }) => {
    const b: any = body;
    if (!b.title || !b.code) return error('Title and code are required', 400);
    const requiresApproval = !!b.requiresApproval;
    const [id] = await db.add('promotions', [{ title: b.title, description: b.description || '', discountPct: b.discountPct || 0, code: String(b.code).toUpperCase(), startDate: b.startDate || '', endDate: b.endDate || '', requiresApproval, approved: !requiresApproval, active: true, createdBy: b.createdBy || 'owner', createdAt: Date.now() }]);
    if (!id) return error('Failed to create promotion', 500);
    await audit('created', 'promotion', { id, title: b.title, code: String(b.code).toUpperCase(), discountPct: b.discountPct || 0 }, b.createdBy || 'owner');
    return json({ id });
  }],
  'PUT /api/promotions/:id': [async ({ params, body }) => {
    requireOwner();
    const [existing] = await db.get('promotions', [params.id]);
    if (!existing) return error('Promotion not found', 404);
    if (existing.lastEmailedAt) return error('This promotion has already been emailed and cannot be edited.', 409);
    const [ok] = await db.update('promotions', [{ id: params.id, record: { ...existing, ...(body as any) } }]);
    if (!ok) return error('Update failed', 500);
    await audit('updated', 'promotion', { ...existing, ...(body as any) }, (body as any)?.actor || 'owner');
    return json({ ok: true });
  }],
  'POST /api/promotions/:id/email': [async ({ params, body }) => {
    const [promotion] = await db.get('promotions', [params.id]);
    if (!promotion) return error('Promotion not found', 404);
    const { items: customers } = await db.list('customers', { limit: 2000 });
    const recipients = (customers as any[]).filter(customer => customer.email && customer.email.includes('@'));
    if (recipients.length === 0) return error('No customers have an email address on their profile', 409);
    const message = `${promotion.title}\n\n${promotion.description || 'A special offer is available for you.'}\n\nDiscount: ${promotion.discountPct}%\nCode: ${promotion.code}\n${promotion.endDate ? `Offer ends: ${promotion.endDate}` : ''}`;
    await Promise.all(recipients.map(customer => notifyCustomer(customer.email, `${promotion.title} - SafiGroom offer`, message, promotion.id)));
    await db.update('promotions', [{ id: params.id, record: { ...promotion, lastEmailedAt: Date.now(), lastEmailedCount: recipients.length, emailSubject: (body as any)?.subject || `${promotion.title} - SafiGroom offer` } }]);
    await audit('emailed', 'promotion', { ...promotion, recipientCount: recipients.length, recipientNames: recipients.map(customer => customer.name) }, (body as any)?.actor || 'owner');
    return json({ sent: recipients.length, delivery: process.env.RESEND_API_KEY ? 'sent' : 'queued' });
  }],

  'GET /api/reviews': [async ({ query }) => {
    const { items } = await db.list('reviews', { limit: 500 });
    const staffId = query.staffId;
    return json({ items: staffId ? (items as any[]).filter(r => r.staffId === staffId) : items });
  }],
  'POST /api/reviews': [async ({ body }) => {
    const b: any = body;
    const rating = Number(b.rating);
    if (!rating || rating < 1 || rating > 5) return error('Rating must be between 1 and 5', 400);
    if (!b.customerId || !b.appointmentId) return error('A completed appointment is required for a review', 400);
    const [appointment] = await db.get('appointments', [b.appointmentId]);
    if (!appointment || appointment.customerId !== b.customerId || appointment.status !== 'completed') return error('Reviews are available after a completed service', 409);
    const { items: existingReviews } = await db.list('reviews', { limit: 2000 });
    if ((existingReviews as any[]).some(item => item.appointmentId === b.appointmentId && item.customerId === b.customerId)) return error('This appointment already has a review', 409);
    const [id] = await db.add('reviews', [{ appointmentId: b.appointmentId || null, customerId: b.customerId || null, customerName: b.customerName || 'Customer', staffId: b.staffId || null, staffName: b.staffName || '', serviceName: b.serviceName || '', rating, comment: b.comment || '', survey: b.survey || {}, createdAt: Date.now() }]);
    if (!id) return error('Failed to submit review', 500);
    await audit('created', 'review', { id, customerName: b.customerName || 'Customer', staffName: b.staffName || '', serviceName: b.serviceName || '', rating }, b.actor || 'customer');
    return json({ id });
  }],

  'POST /api/mpesa/stkpush': [async ({ body }) => {
    const b: any = body;
    const phone = String(b.phone || '').replace(/\s+/g, '');
    if (!/^(?:\+254|0)(7\d{8}|1\d{8})$/.test(phone)) return error('Enter a valid Kenyan M-Pesa phone number', 400);
    const amountKES = Number(b.amountKES);
    if (!amountKES || amountKES <= 0) return error('A valid amount is required', 400);
    const [id] = await db.add('mpesa_transactions', [{ phone, amountKES, purpose: b.purpose || 'payment', referenceId: b.referenceId || null, status: 'pending', mpesaReceiptNumber: null, createdAt: Date.now(), completedAt: null }]);
    if (!id) return error('Failed to initiate STK push', 500);
    await audit('created', 'mpesa_transaction', { id, phone, amountKES, purpose: b.purpose || 'payment', referenceId: b.referenceId || null }, b.actor || 'receptionist');
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = process.env.MPESA_CALLBACK_URL;
    if (!consumerKey || !consumerSecret || !shortcode || !passkey || !callbackUrl) return error('M-Pesa is not configured. Add the Daraja credentials and a public callback URL to the backend environment.', 503);
    try {
      const baseUrl = process.env.MPESA_ENVIRONMENT === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
      const tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}` } });
      const tokenBody: any = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenBody.access_token) throw new Error(tokenBody.errorMessage || 'Could not authenticate with Safaricom Daraja');
      const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
      const pushResponse = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST', headers: { Authorization: `Bearer ${tokenBody.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ BusinessShortCode: shortcode, Password: password, Timestamp: timestamp, TransactionType: 'CustomerPayBillOnline', Amount: Math.round(amountKES), PartyA: phone.replace(/^0/, '254').replace(/^\+/, ''), PartyB: shortcode, PhoneNumber: phone.replace(/^0/, '254').replace(/^\+/, ''), CallBackURL: callbackUrl, AccountReference: `SG-${id.slice(0, 8)}`, TransactionDesc: b.purpose || 'SafiGroom payment' }),
      });
      const pushBody: any = await pushResponse.json();
      if (!pushResponse.ok || !pushBody.CheckoutRequestID) throw new Error(pushBody.errorMessage || pushBody.ResponseDescription || 'Safaricom rejected the STK push');
      const [transaction] = await db.get('mpesa_transactions', [id]);
      await db.update('mpesa_transactions', [{ id, record: { ...transaction, checkoutRequestId: pushBody.CheckoutRequestID, merchantRequestId: pushBody.MerchantRequestID || null, providerResponse: pushBody } }]);
    } catch (cause) {
      console.error('M-Pesa STK Push failed', cause);
      const [transaction] = await db.get('mpesa_transactions', [id]);
      if (transaction) await db.update('mpesa_transactions', [{ id, record: { ...transaction, status: 'failed', failureReason: cause instanceof Error ? cause.message : 'M-Pesa request failed', completedAt: Date.now() } }]);
      return error(cause instanceof Error ? cause.message : 'M-Pesa request failed', 502);
    }
    return json({ id, status: 'pending' });
  }],
  'POST /api/mpesa/callback': [async ({ body }) => {
    const callback = (body as any)?.Body?.stkCallback;
    if (!callback?.CheckoutRequestID) return json({ ok: true });
    const { items } = await db.list('mpesa_transactions', { limit: 1000 });
    const transaction = (items as any[]).find(item => item.checkoutRequestId === callback.CheckoutRequestID);
    if (!transaction) return json({ ok: true });
    const metadata = Object.fromEntries(((callback.CallbackMetadata?.Item || []) as any[]).map(item => [item.Name, item.Value]));
    await db.update('mpesa_transactions', [{ id: transaction.id, record: { ...transaction, status: Number(callback.ResultCode) === 0 ? 'completed' : 'failed', mpesaReceiptNumber: metadata.MpesaReceiptNumber || null, completedAt: Date.now(), callbackResult: callback } }]);
    return json({ ok: true });
  }],
  'GET /api/mpesa/status/:id': [async ({ params }) => {
    const [txn] = await db.get('mpesa_transactions', [params.id]) as any[];
    if (!txn) return error('Transaction not found', 404);
    if (txn.status === 'pending' && !process.env.MPESA_CONSUMER_KEY && Date.now() - (txn.createdAt as number) > 3500) {
      const receipt = 'S' + Math.random().toString(36).slice(2, 10).toUpperCase();
      await db.update('mpesa_transactions', [{ id: params.id, record: { ...txn, status: 'completed', mpesaReceiptNumber: receipt, completedAt: Date.now() } }]);
      return json({ id: params.id, status: 'completed', mpesaReceiptNumber: receipt, amountKES: txn.amountKES, phone: txn.phone });
    }
    return json({ id: params.id, status: txn.status, mpesaReceiptNumber: txn.mpesaReceiptNumber, failureReason: txn.failureReason || null, amountKES: txn.amountKES, phone: txn.phone });
  }],

  'GET /api/background': [async () => {
    const path = 'assets/salon-bg-v2.png';
    const [existing] = await storage.read([path]);
    if (!existing || !existing.content) {
      const result = await ai.imageGen();
      const [ok] = await storage.write([{ path, content: result.image.data }]);
      if (!ok) return error('Failed to generate background image', 500);
    }
    const [{ url }] = await storage.url([path]);
    return json({ url });
  }],
});
