export type Currency = 'KES' | 'USD';

export interface Staff {
  id: string;
  name: string;
  role: string;
  specialties: string[];
  branch: string;
  chair: string;
  phone: string;
  commissionPct: number;
  status: 'available' | 'in-service' | 'break' | 'off';
  accountEmail?: string;
  accountStatus?: 'active' | 'pending' | 'disabled';
  employmentStatus?: 'active' | 'laid-off';
  branchId?: string;
  branchName?: string;
  commissionEarned14Days?: number;
  assistantEarned14Days?: number;
  tipEarned14Days?: number;
}

export interface Branch {
  id: string;
  salonId: string;
  name: string;
  address?: string;
  status: 'active' | 'inactive';
}

export interface ServiceItem {
  id: string;
  name: string;
  category: string;
  price: number;
  currency: Currency;
  durationMin: number;
  description: string;
  staffCount: 1 | 2;
  commissionPct: 30 | 33.33 | 40 | 50;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  notes: string;
  loyaltyPoints: number;
  totalSpent: number;
  totalSpentUSD: number;
  visits: number;
  lastVisit: number | null;
  createdAt: number;
  membershipTier?: string;
  membershipExpiry?: number | null;
  membershipPlanId?: string | null;
}

export type AppointmentStatus = 'pending' | 'confirmed' | 'checked-in' | 'in-service' | 'completed' | 'cancelled' | 'no-show';

export interface AppointmentServiceLine {
  serviceId: string;
  serviceName: string;
  price: number;
  currency: Currency;
  durationMin: number;
  staffId: string;
  staffName: string;
}

export interface Appointment {
  id: string;
  customerId: string | null;
  customerName: string;
  serviceId: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  date: string;
  time: string;
  durationMin: number;
  price: number;
  currency: Currency;
  items?: AppointmentServiceLine[];
  status: AppointmentStatus;
  customerEmail?: string;
  createdAt?: number;
  ticketNumber?: string;
  branchId?: string;
  branchName?: string;
}

export type QueueStatus = 'waiting' | 'in-service' | 'completed';

export interface QueueEntry {
  id: string;
  customerName: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  status: QueueStatus;
  joinedAt: number;
  position: number;
  customerId?: string | null;
  customerEmail?: string;
  appointmentId?: string | null;
  ticketNumber?: string;
  calledAt?: number;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  color?: string;
  price: number;
  cost: number;
  stock: number;
  lowStockThreshold: number;
  unit: string;
}

export interface OrderItem {
  type: 'service' | 'product';
  refId: string;
  name: string;
  price: number;
  currency: Currency;
  qty: number;
  staffId?: string | null;
  staffName?: string | null;
}

export interface Order {
  id: string;
  customerId: string | null;
  customerName: string;
  items: OrderItem[];
  discountPct: number;
  discountSource?: string;
  promoCode?: string | null;
  pointsRedeemed?: number;
  subtotalByCurrency: Record<string, number>;
  discountByCurrency: Record<string, number>;
  totalByCurrency: Record<string, number>;
  paymentMethod: string;
  createdAt: number;
}

export interface Expense {
  id: string;
  category: string;
  amount: number;
  note: string;
  date: string;
}

export interface PayoutBatch {
  id: string;
  range: 'today' | 'week' | 'fortnight' | 'month' | 'all';
  from: number;
  to: number;
  totalKES: number;
  employeeCount: number;
  itemCount: number;
  status: 'recorded';
  createdAt: number;
}

export interface PayrollResult {
  id: string;
  totalKES: number;
  employeeCount: number;
  sentCount: number;
  failedCount: number;
  status: 'submitted' | 'failed';
}

export type Role = 'owner' | 'manager' | 'receptionist' | 'barber' | 'customer' | 'admin';

export type ChatChannel = string;

export interface ChatMessage {
  id: string;
  channel: ChatChannel;
  senderName: string;
  senderRole: string;
  text: string;
  createdAt: number;
}

export interface DashboardData {
  range: string;
  revenueByCurrency: Record<string, number>;
  ordersCount: number;
  paymentMethodTotals: Record<'Cash' | 'Card' | 'M-Pesa', number>;
  expenseTotal: number;
  productCost: number;
  commissionsByCurrency: Record<string, number>;
  estimatedProfitByCurrency: Record<string, number>;
  todaysAppointmentsCount: number;
  upcomingAppointments: Appointment[];
  lowStockProducts: Product[];
  activeStaffCount: number;
  totalStaffCount: number;
  waitingQueueCount: number;
  customersCount: number;
  customers: Customer[];
  topStaff: { name: string; currency: Currency; revenue: number; commission: number; helperDeductions: number; count: number }[];
  commissionByClient: { clientId: string | null; clientName: string; staffName: string; serviceName: string; revenue: number; assistantPayment: number; commission: number; currency: Currency; createdAt: number }[];
  topServices: { name: string; currency: Currency; revenue: number; count: number }[];
  trend: { date: string; revenue: number }[];
}

export interface RebookingItem {
  customerId: string;
  customerName: string;
  avgIntervalDays: number;
  predictedDate: string;
  daysUntil: number;
  lastVisit: string;
}

export interface MembershipPlan {
  id: string;
  name: string;
  discountPct: number;
  priceKES: number;
  durationDays: number;
  benefits: string[];
}

export interface Promotion {
  id: string;
  title: string;
  description: string;
  discountPct: number;
  code: string;
  startDate: string;
  endDate: string;
  requiresApproval: boolean;
  approved: boolean;
  active: boolean;
  createdBy: string;
  createdAt: number;
}

export interface Review {
  id: string;
  appointmentId: string | null;
  customerId: string | null;
  customerName: string;
  staffId: string | null;
  staffName: string;
  serviceName: string;
  rating: number;
  comment: string;
  survey?: Record<string, string | number | boolean>;
  createdAt: number;
}

export interface AuditLog {
  id: string;
  action: string;
  collection: string;
  actor: string;
  recordId: string | null;
  summary: string;
  recordSnapshot: Record<string, unknown>;
  createdAt: number;
}
