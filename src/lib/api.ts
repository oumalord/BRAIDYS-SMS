import type { Staff, ServiceItem, Customer, Appointment, QueueEntry, Product, Order, Expense, DashboardData, RebookingItem, ChatChannel, ChatMessage, Currency, MembershipPlan, Promotion, Review, AuditLog, Branch, PayoutBatch } from '../types';

const api = {
  get: async (path: string) => ({ data: await request(path) }),
  post: async (path: string, body?: unknown) => ({ data: await request(path, 'POST', body) }),
  put: async (path: string, body?: unknown) => ({ data: await request(path, 'PUT', body) }),
  delete: async (path: string) => ({ data: await request(path, 'DELETE') }),
};

async function request(path: string, method = 'GET', body?: unknown): Promise<any> {
  const token = window.localStorage.getItem('safigroom_session');
  const branchId = window.localStorage.getItem('safigroom_selected_branch');
  let account: { role?: string } | null = null;
  try { account = JSON.parse(window.localStorage.getItem('safigroom_account') || 'null'); } catch { account = null; }
  const canSelectBranch = account?.role === 'owner' || account?.role === 'manager' || account?.role === 'admin';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(canSelectBranch ? { 'X-Branch-ID': branchId || '' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  } finally {
    window.clearTimeout(timeout);
  }
}

export const fmtMoney = (amount: number, currency: Currency | string = 'KES') => currency === 'USD' ? `$${(amount || 0).toFixed(2)}` : `KES ${Math.round(amount || 0).toLocaleString()}`;
export const fmtKES = (n: number) => fmtMoney(n, 'KES');

// Lightweight in-memory response cache so switching tabs doesn't re-fetch
// unchanged data every time. Mutations invalidate the relevant prefix.
const cache = new Map<string, { data: unknown; ts: number }>();
function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const scope = `${window.localStorage.getItem('safigroom_account') || ''}:${window.localStorage.getItem('safigroom_selected_branch') || 'all'}`;
  const scopedKey = `${scope}:${key}`;
  const hit = cache.get(scopedKey);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.data as T);
  return fetcher().then(data => { cache.set(scopedKey, { data, ts: Date.now() }); return data; });
}
function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.endsWith(`:${prefix}`) || k.includes(`:${prefix}:`)) cache.delete(k);
}

export const seed = () => api.post('/api/seed');

export const AuthApi = {
  login: async (identifier: string, credential: string) => {
    const result = await api.post('/api/auth/login', { identifier, credential });
    window.localStorage.setItem('safigroom_session', result.data.token);
    window.localStorage.setItem('safigroom_account', JSON.stringify(result.data.account));
    if (result.data.account.branchId) window.localStorage.setItem('safigroom_selected_branch', result.data.account.branchId);
    return result.data.account;
  },
  signup: async (payload: { name: string; email?: string; phone: string; pin: string; salonId: string; branchId: string }) => {
    const result = await api.post('/api/auth/signup', payload);
    window.localStorage.setItem('safigroom_session', result.data.token);
    window.localStorage.setItem('safigroom_account', JSON.stringify(result.data.account));
    if (result.data.account.branchId) window.localStorage.setItem('safigroom_selected_branch', result.data.account.branchId);
    return result.data.account;
  },
  logout: () => { window.localStorage.removeItem('safigroom_session'); window.localStorage.removeItem('safigroom_account'); window.localStorage.removeItem('safigroom_selected_branch'); },
  hasSession: () => Boolean(window.localStorage.getItem('safigroom_session')),
  account: () => { try { return JSON.parse(window.localStorage.getItem('safigroom_account') || 'null'); } catch { return null; } },
  demo: () => api.post('/api/auth/demo'),
};

export const PublicApi = {
  salons: () => api.get('/api/public/salons').then(r => r.data.items as { id: string; name: string }[]),
  branches: (salonId: string) => api.get(`/api/public/branches?salonId=${encodeURIComponent(salonId)}`).then(r => r.data.items as Branch[]),
};

export const BranchesApi = {
  list: () => api.get('/api/branches').then(r => r.data.items as Branch[]),
};

export const AdminApi = {
  directory: () => api.get('/api/admin/directory').then(r => r.data),
  createSalon: (payload: unknown) => api.post('/api/admin/salons', payload),
  createBranch: (payload: unknown) => api.post('/api/admin/branches', payload),
  resetPassword: (accountId: string, newPassword: string) => api.post(`/api/admin/accounts/${accountId}/reset-password`, { newPassword }),
};

export const StaffApi = {
  list: () => cached('staff:list', 20000, () => api.get('/api/staff').then(r => r.data.items as Staff[])),
  create: (s: Partial<Staff>) => api.post('/api/staff', s).then(r => { invalidate('staff'); return r; }),
  update: (id: string, patch: Partial<Staff> & { password?: string }) => api.put(`/api/staff/${id}`, patch).then(r => { invalidate('staff'); return r; }),
  changeMyPin: (pin: string) => api.post('/api/staff/me/pin', { pin }),
  myEarnings: () => api.get('/api/staff/me/earnings').then(r => r.data as { today: { commission: number; assistant: number; tips: number; total: number }; fortnight: { commission: number; assistant: number; tips: number; total: number } }),
};

export const ServicesApi = {
  list: () => cached('services:list', 30000, () => api.get('/api/services').then(r => r.data.items as ServiceItem[])),
  create: (s: Partial<ServiceItem>) => api.post('/api/services', s).then(r => { invalidate('services'); return r; }),
  update: (id: string, patch: Partial<ServiceItem>) => api.put(`/api/services/${id}`, patch).then(r => { invalidate('services'); return r; }),
};

export const CustomersApi = {
  list: () => cached('customers:list', 15000, () => api.get('/api/customers').then(r => r.data.items as Customer[])),
  create: (c: Partial<Customer>) => api.post('/api/customers', c).then(r => { invalidate('customers'); return r; }),
  update: (id: string, patch: Partial<Customer> & { pin?: string }) => api.put(`/api/customers/${id}`, patch).then(r => { invalidate('customers'); return r; }),
  changePin: (customerId: string, pin: string) => api.post(`/api/customers/${customerId}/pin`, { pin }),
};

export const AppointmentsApi = {
  list: (date?: string) => api.get(date ? `/api/appointments?date=${date}` : '/api/appointments').then(r => r.data.items as Appointment[]),
  create: (a: unknown) => api.post('/api/appointments', a).then(r => { invalidate('dashboard'); return r; }),
  update: (id: string, patch: Partial<Appointment>) => api.put(`/api/appointments/${id}`, patch).then(r => { invalidate('dashboard'); return r; }),
  deleteCancelled: () => api.delete('/api/appointments/cancelled').then(r => { invalidate('dashboard'); return r; }),
};

export const CustomerApi = {
  find: (query: string) => api.get(`/api/customer/dashboard?query=${encodeURIComponent(query)}`).then(r => r.data),
  membershipPurchase: (payload: { customerId: string; planId: string; mpesaReceiptNumber?: string }) => api.post('/api/memberships/purchase', payload).then(r => { invalidate('customers'); return r; }),
};

export const QueueApi = {
  list: () => api.get('/api/queue').then(r => r.data.items as QueueEntry[]),
  join: (q: Partial<QueueEntry>) => api.post('/api/queue', q).then(r => { invalidate('dashboard'); return r; }),
  update: (id: string, patch: Partial<QueueEntry>) => api.put(`/api/queue/${id}`, patch).then(r => { invalidate('dashboard'); return r; }),
};

export const AuditApi = {
  list: () => api.get('/api/audit-logs').then(r => r.data.items as AuditLog[]),
};

export const ProductsApi = {
  list: () => cached('products:list', 15000, () => api.get('/api/products').then(r => r.data.items as Product[])),
  create: (p: Partial<Product>) => api.post('/api/products', p).then(r => { invalidate('products'); return r; }),
  update: (id: string, patch: Partial<Product>) => api.put(`/api/products/${id}`, patch).then(r => { invalidate('products'); return r; }),
  remove: (id: string) => api.delete(`/api/products/${id}`).then(r => { invalidate('products'); return r; }),
};

export const OrdersApi = {
  list: () => api.get('/api/orders').then(r => r.data.items as Order[]),
  checkout: (payload: unknown) => api.post('/api/orders', payload).then(r => { invalidate('products'); invalidate('customers'); invalidate('dashboard'); return r; }),
  completion: (appointmentId: string) => api.get(`/api/appointments/${appointmentId}/completion`).then(r => r.data.item),
  updateCompletion: (orderId: string, payload: unknown) => api.put(`/api/orders/${orderId}/completion`, payload).then(r => { invalidate('dashboard'); return r; }),
};

export const ExpensesApi = {
  list: () => api.get('/api/expenses').then(r => r.data.items as Expense[]),
  create: (e: Partial<Expense>) => api.post('/api/expenses', e).then(r => { invalidate('dashboard'); return r; }),
};

export const PayoutsApi = {
  list: () => api.get('/api/payouts').then(r => r.data.items as PayoutBatch[]),
  record: (range: 'today' | 'week' | 'fortnight' | 'month' | 'all') => api.post('/api/payouts', { range }),
};

export const PayrollApi = {
  staff: () => api.get('/api/payroll/staff').then(r => r.data.items as Staff[]),
  send: (recipients: { staffId: string; amountKES: number; phone: string }[]) => api.post('/api/payroll/send', { recipients }),
};

export const DashboardApi = {
  get: (range: string) => cached(`dashboard:${range}`, 10000, () => api.get(`/api/dashboard?range=${range}`).then(r => r.data as DashboardData)),
};

export const RebookingApi = {
  list: () => api.get('/api/analytics/rebooking').then(r => r.data.items as RebookingItem[]),
};

export const AiApi = {
  ask: (question: string) => api.post('/api/ai/ask', { question }),
};

export const MessagesApi = {
  list: (channel: ChatChannel) => api.get(`/api/messages?channel=${encodeURIComponent(channel)}`).then(r => r.data.items as ChatMessage[]),
  send: (payload: { channel: ChatChannel; senderName: string; senderRole: string; text: string }) => api.post('/api/messages', payload),
};

function csvCell(v: string | number): string {
  const q = String.fromCharCode(34);
  return q + String(v).replace(new RegExp(q, 'g'), q + q) + q;
}

export function downloadCSV(filename: string, rows: (string | number)[][]) {
  const nl = String.fromCharCode(10);
  const csv = rows.map(r => r.map(csvCell).join(',')).join(nl);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const MembershipsApi = {
  list: () => cached('memberships:list', 60000, () => api.get('/api/memberships').then(r => r.data.items as MembershipPlan[])),
  create: (p: Partial<MembershipPlan>) => api.post('/api/memberships', p).then(r => { invalidate('memberships'); return r; }),
};

export const PromotionsApi = {
  list: () => cached('promotions:list', 20000, () => api.get('/api/promotions').then(r => r.data.items as Promotion[])),
  create: (p: Partial<Promotion>) => api.post('/api/promotions', p).then(r => { invalidate('promotions'); return r; }),
  update: (id: string, patch: Partial<Promotion>) => api.put(`/api/promotions/${id}`, patch).then(r => { invalidate('promotions'); return r; }),
  emailCustomers: (id: string, subject?: string) => api.post(`/api/promotions/${id}/email`, { subject }).then(r => { invalidate('promotions'); return r; }),
};

export const ReviewsApi = {
  list: (staffId?: string) => api.get(staffId ? `/api/reviews?staffId=${staffId}` : '/api/reviews').then(r => r.data.items as Review[]),
  create: (r: Partial<Review>) => api.post('/api/reviews', r),
};

export const MpesaApi = {
  stkPush: (payload: { phone: string; amountKES: number; purpose: string; referenceId?: string }) => api.post('/api/mpesa/stkpush', payload),
  status: (id: string) => api.get(`/api/mpesa/status/${id}`),
};

export const BackgroundApi = {
  get: () => api.get('/api/background').then(r => r.data.url as string),
};
