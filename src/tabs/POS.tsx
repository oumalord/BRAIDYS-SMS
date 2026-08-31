import { useEffect, useRef, useState } from 'react';
import { Plus, ShoppingCart } from 'lucide-react';
import { Card, Button, Modal, Field, Input, Select, toast } from '../components/ui';
import { CustomersApi, ServicesApi, ProductsApi, StaffApi, OrdersApi, PosDraftsApi, AppointmentsApi, fmtMoney } from '../lib/api';
import { MpesaPayModal } from '../components/MpesaPay';
import type { Appointment, Customer, ServiceItem, Product, Staff, Currency } from '../types';

interface ConsumedProductLine { productId: string; name: string; qty: number; cost: number; unit?: string; }
interface CartLine { key: string; type: 'service' | 'product'; refId: string; name: string; price: number; currency: Currency; qty: number; staffCount?: 1 | 2; commissionPct?: 30 | 33.35 | 40 | 50; staffId?: string; staffName?: string; coStaffId?: string; coStaffName?: string; thirdStaffId?: string; thirdStaffName?: string; helperStaffId?: string; helperStaffName?: string; assistantPayment?: number; primaryCommission?: number; coStaffCommission?: number; thirdStaffCommission?: number; consumedProducts?: ConsumedProductLine[]; }

function todayStr() { return new Date().toISOString().slice(0, 10); }
function hasSpecialAssistantBraid(line: CartLine): boolean {
  return (line.consumedProducts || []).some(product => ['amara', 'diani'].includes(product.name.trim().toLowerCase()));
}
function assistantCompensation(serviceFee: number, hasSpecialBraid = false): number {
  if (hasSpecialBraid) return 400;
  if (serviceFee <= 1800) return 200;
  if (serviceFee <= 2400) return 300;
  if (serviceFee <= 3300) return 400;
  return 500;
}

function POS({ onSaleComplete, appointment, currentStaffId }: { onSaleComplete: () => void; appointment?: Appointment; currentStaffId?: string }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [servingClients, setServingClients] = useState<Customer[]>([]);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [discountPct, setDiscountPct] = useState(0);
  const [promoCode, setPromoCode] = useState('');
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('M-Pesa');
  const [checkingOut, setCheckingOut] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [receipt, setReceipt] = useState<any>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [tab, setTab] = useState<'services' | 'products'>('services');
  const [usagePickerByLine, setUsagePickerByLine] = useState<Record<string, string>>({});
  const staffAutoSelectedClientRef = useRef(false);

  useEffect(() => {
    let active = true;
    setHasDraft(false);
    PosDraftsApi.load(appointment?.id).then(draft => {
      if (!active || !draft || !Array.isArray(draft.cart) || !draft.cart.length) return;
      setCart(draft.cart as CartLine[]);
      setCustomerId(String(draft.customerId || ''));
      setDiscountPct(Number(draft.discountPct || 0));
      setPromoCode(String(draft.promoCode || ''));
      setRedeemPoints(Number(draft.redeemPoints || 0));
      setPaymentMethod(String(draft.paymentMethod || 'M-Pesa'));
      setHasDraft(true);
    }).catch(() => { if (active) toast('Could not load your saved POS draft.', 'error'); });
    return () => { active = false; };
  }, [appointment?.id]);

  useEffect(() => {
    Promise.all([CustomersApi.list(), ServicesApi.list(), ProductsApi.list(), StaffApi.list()]).then(([c, s, p, st]) => { setCustomers(c); setServices(s); setProducts(p); setStaff(st); });
  }, []);

  useEffect(() => {
    if (!currentStaffId) return;
    AppointmentsApi.list(todayStr()).then(appointments => {
      const assigned = appointments.filter(item => item.staffId === currentStaffId && ['pending', 'confirmed', 'checked-in', 'in-service'].includes(item.status) && item.customerId);
      const clientIds = new Set(assigned.map(item => item.customerId as string));
      setServingClients(customers.filter(customer => clientIds.has(customer.id)));
      if (appointment?.customerId) return;
      const priorityStatus = ['in-service', 'checked-in', 'confirmed', 'pending'];
      const preferred = priorityStatus
        .map(status => assigned.find(item => item.status === status))
        .find(Boolean);
      const preferredCustomerId = preferred?.customerId || '';
      setCustomerId(previous => {
        if (previous && clientIds.has(previous)) {
          if (!staffAutoSelectedClientRef.current && preferredCustomerId && previous !== preferredCustomerId) {
            staffAutoSelectedClientRef.current = true;
            return preferredCustomerId;
          }
          return previous;
        }
        if (preferredCustomerId) {
          staffAutoSelectedClientRef.current = true;
          return preferredCustomerId;
        }
        return '';
      });
    }).catch(() => toast('Could not load your active clients.', 'error'));
  }, [currentStaffId, customers, appointment?.customerId]);

  useEffect(() => {
    if (!appointment || !services.length || cart.length) return;
    const service = services.find(item => item.id === appointment.serviceId);
    if (service) addService(service, appointment.staffId || currentStaffId);
    if (appointment.customerId) setCustomerId(appointment.customerId);
  }, [appointment, services]);

  const addService = (s: ServiceItem, assignedStaffId = currentStaffId) => {
    const assignedStaff = staff.find(member => member.id === assignedStaffId);
    const staffCount = s.staffCount || 1;
    return setCart(c => [...c, { key: `${s.id}-${Date.now()}`, type: 'service', refId: s.id, name: s.name, price: s.price, currency: s.currency, qty: 1, staffCount, commissionPct: s.commissionPct || (staffCount === 2 ? 33.35 : 50), staffId: assignedStaff?.id, staffName: assignedStaff?.name, consumedProducts: [] }]);
  };
  const addProduct = (p: Product) => {
    setCart(c => {
      const existing = c.find(l => l.type === 'product' && l.refId === p.id);
      if (existing) {
        if (existing.qty >= p.stock) {
          toast(`Only ${p.stock} ${p.unit} of ${p.name} are available.`, 'error');
          return c;
        }
        return c.map(l => l === existing ? { ...l, qty: l.qty + 1 } : l);
      }
      return [...c, { key: `${p.id}-${Date.now()}`, type: 'product', refId: p.id, name: p.name, price: p.price, currency: 'KES', qty: 1 }];
    });
  };
  const removeLine = (key: string) => setCart(c => c.filter(l => l.key !== key));
  const setLineStaff = (key: string, staffId: string) => {
    const s = staff.find(x => x.id === staffId);
    setCart(c => c.map(l => l.key === key ? { ...l, staffId: s?.id, staffName: s?.name } : l));
  };
  const setLineCoStaff = (key: string, coStaffId: string) => {
    const coStaff = staff.find(x => x.id === coStaffId);
    setCart(c => c.map(l => l.key === key ? { ...l, coStaffId: coStaff?.id, coStaffName: coStaff?.name } : l));
  };
  const setLineThirdStaff = (key: string, thirdStaffId: string) => {
    const thirdStaff = staff.find(x => x.id === thirdStaffId);
    setCart(c => c.map(l => l.key === key ? { ...l, thirdStaffId: thirdStaff?.id, thirdStaffName: thirdStaff?.name } : l));
  };
  const setStaffCount = (key: string, staffCount: 1 | 2) => setCart(current => current.map(line => line.key === key ? { ...line, staffCount, ...(staffCount === 1 ? { coStaffId: undefined, coStaffName: undefined, coStaffCommission: 0, thirdStaffId: undefined, thirdStaffName: undefined, thirdStaffCommission: 0 } : {}) } : line));
  const toggleThirdStaff = (key: string) => setCart(current => current.map(line => line.key === key ? line.thirdStaffId !== undefined ? { ...line, thirdStaffId: undefined, thirdStaffName: undefined, thirdStaffCommission: 0 } : { ...line, thirdStaffId: '' } : line));
  const setManualAmount = (key: string, field: 'primaryCommission' | 'coStaffCommission' | 'thirdStaffCommission' | 'assistantPayment', value: number) => setCart(current => current.map(line => line.key === key ? { ...line, [field]: Math.max(0, value) } : line));
  const setLineHelper = (key: string, helperStaffId: string) => {
    const helper = staff.find(x => x.id === helperStaffId);
    setCart(c => c.map(l => l.key === key ? { ...l, helperStaffId: helper?.id, helperStaffName: helper?.name, assistantPayment: helper ? assistantCompensation(l.price * l.qty, hasSpecialAssistantBraid(l)) : 0 } : l));
  };
  const setLineQty = (key: string, qty: number) => setCart(c => c.map(l => l.key === key ? { ...l, qty: Math.max(1, qty) } : l));
  const addUsedProduct = (lineKey: string, productId: string) => {
    const product = products.find(item => item.id === productId);
    if (!product) return;
    setCart(current => current.map(line => {
      if (line.key !== lineKey || line.type !== 'service') return line;
      const consumed = line.consumedProducts || [];
      const existing = consumed.find(item => item.productId === product.id);
      if (existing) {
        return {
          ...line,
          consumedProducts: consumed.map(item => item.productId === product.id ? { ...item, qty: item.qty + 1 } : item),
        };
      }
      return {
        ...line,
        consumedProducts: [...consumed, { productId: product.id, name: product.name, qty: 1, cost: Number(product.cost || 0), unit: product.unit }],
      };
    }));
    setUsagePickerByLine(prev => ({ ...prev, [lineKey]: '' }));
  };
  const setUsedProductQty = (lineKey: string, productId: string, qty: number) => {
    setCart(current => current.map(line => {
      if (line.key !== lineKey || line.type !== 'service') return line;
      const consumed = line.consumedProducts || [];
      if (qty <= 0) return { ...line, consumedProducts: consumed.filter(item => item.productId !== productId) };
      return {
        ...line,
        consumedProducts: consumed.map(item => item.productId === productId ? { ...item, qty: Math.max(1, qty) } : item),
      };
    }));
  };
  const removeUsedProduct = (lineKey: string, productId: string) => {
    setCart(current => current.map(line => {
      if (line.key !== lineKey || line.type !== 'service') return line;
      return { ...line, consumedProducts: (line.consumedProducts || []).filter(item => item.productId !== productId) };
    }));
  };

  const currencies = Array.from(new Set(cart.map(l => l.currency)));
  const subtotalByCurrency: Record<string, number> = {};
  for (const l of cart) subtotalByCurrency[l.currency] = (subtotalByCurrency[l.currency] || 0) + l.price * l.qty;
  const totalByCurrency: Record<string, number> = {};
  for (const cur of currencies) totalByCurrency[cur] = Math.round((subtotalByCurrency[cur] || 0) * (1 - discountPct / 100));
  const serviceTotal = cart.filter(line => line.type === 'service').reduce((sum, line) => sum + line.price * line.qty, 0);
  const serviceTotalAfterDiscount = Math.round(serviceTotal * (1 - discountPct / 100));
  const productTotal = cart.filter(line => line.type === 'product').reduce((sum, line) => sum + line.price * line.qty, 0);
  const assistantTotal = cart
    .filter(line => line.type === 'service' && line.helperStaffId)
    .reduce((sum, line) => sum + Number(line.assistantPayment || 0), 0);
  const serviceProductCost = cart
    .filter(line => line.type === 'service')
    .reduce((sum, line) => sum + (line.consumedProducts || []).reduce((lineSum, item) => lineSum + (Number(item.cost || 0) * Number(item.qty || 0)), 0), 0);
  const expectedIncome = Math.max(0, serviceTotalAfterDiscount - serviceProductCost - assistantTotal) * 0.5;

  const customerOptions = currentStaffId ? servingClients : customers;
  const selectedCustomer = customerOptions.find(c => c.id === customerId);
  const productQuantityInCart = (productId: string) => cart.find(line => line.type === 'product' && line.refId === productId)?.qty || 0;
  const applyDraft = (draft: Record<string, any>) => {
    setCart(draft.cart as CartLine[]); setCustomerId(String(draft.customerId || '')); setDiscountPct(Number(draft.discountPct || 0)); setPromoCode(String(draft.promoCode || '')); setRedeemPoints(Number(draft.redeemPoints || 0)); setPaymentMethod(String(draft.paymentMethod || 'M-Pesa'));
  };
  const saveDraft = async () => {
    if (!cart.length) { toast('Add a service or product before saving a draft.', 'error'); return; }
    try {
      await PosDraftsApi.save({ appointmentId: appointment?.id || '', cart, customerId, discountPct, promoCode, redeemPoints, paymentMethod });
      setHasDraft(true);
      toast('POS draft saved.', 'success');
    } catch (cause: any) {
      toast(cause?.message || 'Could not save the POS draft.', 'error');
    }
  };
  const restoreDraft = async () => {
    try {
      const draft = await PosDraftsApi.load(appointment?.id);
      if (!draft || !Array.isArray(draft.cart) || !draft.cart.length) { toast('No saved draft was found.', 'error'); return; }
      applyDraft(draft);
      toast('POS draft restored.', 'success');
    } catch (cause: any) {
      toast(cause?.message || 'Could not restore the POS draft.', 'error');
    }
  };

  const doCheckout = async (mpesaReceiptNumber?: string) => {
    setCheckingOut(true);
    try {
      const { data } = await OrdersApi.checkout({
        customerId: selectedCustomer?.id || null,
        customerName: selectedCustomer?.name || 'Walk-in Customer',
          items: cart.map(l => ({
            type: l.type,
            refId: l.refId,
            name: l.name,
            price: l.price,
            currency: l.currency,
            qty: l.qty,
            ...(l.type === 'service' ? { staffCount: l.staffCount || 1, commissionPct: l.commissionPct || 50, staffId: l.staffId || null, staffName: l.staffName || null, coStaffId: l.staffCount === 2 ? l.coStaffId || null : null, coStaffName: l.staffCount === 2 ? l.coStaffName || null : null, thirdStaffId: l.thirdStaffId || null, thirdStaffName: l.thirdStaffName || null, helperStaffId: l.helperStaffId || null, helperStaffName: l.helperStaffName || null, assistantPayment: Number(l.assistantPayment || 0), primaryCommission: l.primaryCommission, coStaffCommission: l.coStaffCommission, thirdStaffCommission: l.thirdStaffCommission, consumedProducts: (l.consumedProducts || []).map(item => ({ productId: item.productId, name: item.name, qty: Number(item.qty || 0), cost: Number(item.cost || 0), unit: item.unit || '' })) } : {}),
          })),
        discountPct, paymentMethod, promoCode: promoCode.trim() || undefined, redeemPoints: redeemPoints || undefined, mpesaReceiptNumber, appointmentId: appointment?.id,
      });
      setReceipt({ ...data, customerName: selectedCustomer?.name || 'Walk-in Customer', items: cart, paymentMethod });
      setCart([]); setDiscountPct(0); setCustomerId(''); setPromoCode(''); setRedeemPoints(0); setShowPay(false);
      PosDraftsApi.clear(appointment?.id).catch(() => undefined); setHasDraft(false);
      onSaleComplete();
    } catch (err: any) {
      console.error('Checkout error:', err);
      const msg = err?.message || 'Checkout failed. Please try again.';
      toast(msg, 'error');
      setShowPay(false);
    } finally {
      setCheckingOut(false);
    }
  };

  const checkout = () => {
    if (cart.length === 0) { toast('Cart is empty.', 'error'); return; }
    if (currentStaffId && !customerId) { toast('Please select a client you are serving.', 'error'); return; }
    const missingStaff = cart.find(l => l.type === 'service' && !l.staffId);
    if (missingStaff) { toast('Assign a staff member to every service before checkout.', 'error'); return; }
    const kesDue = totalByCurrency.KES || 0;
    if (paymentMethod === 'M-Pesa' && kesDue > 0) {
      setShowPay(true);
    } else {
      doCheckout();
    }
  };

  const categories = Array.from(new Set(services.map(s => s.category)));
  const assignableStaff = staff.filter(member => member.employmentStatus !== 'laid-off' && member.status !== 'off');

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><ShoppingCart size={20} aria-hidden="true" />{appointment ? `Complete ${appointment.customerName}'s appointment` : 'Point of Sale'}</h1><p className="text-sm text-[#6E6E73]">{appointment ? 'Add products used, review the exact total, and record payment to complete the appointment.' : 'Build a cart, assign staff, and take payment in KES or USD. Add multiple services from different staff for joint work.'}</p></div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex gap-1 bg-black/5 rounded-full p-1 w-fit">
            <button onClick={() => setTab('services')} className={`px-4 py-1.5 text-sm rounded-full ${tab === 'services' ? 'bg-white shadow-sm' : 'text-[#6E6E73]'}`}>Services</button>
            <button onClick={() => setTab('products')} className={`px-4 py-1.5 text-sm rounded-full ${tab === 'products' ? 'bg-white shadow-sm' : 'text-[#6E6E73]'}`}>Products</button>
          </div>

          {tab === 'services' ? (
            <div className="space-y-5">
              {categories.map(cat => (
                <div key={cat}>
                  <h3 className="text-xs font-semibold text-[#6E6E73] uppercase tracking-wide mb-2">{cat}</h3>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {services.filter(s => s.category === cat).map(s => (
                      <button key={s.id} onClick={() => addService(s)} className={`text-left rounded-2xl border p-3 hover:border-[#0071e3]/40 hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] ${s.commissionPct === 40 ? 'border-amber-300 bg-amber-50/40' : 'border-black/5 bg-white'}`}>
                        <div className="flex items-center justify-between gap-2"><p className="font-medium text-sm">{s.name}</p>{s.commissionPct === 40 && <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">40%</span>}</div>
                        <p className="text-xs text-[#6E6E73]">{fmtMoney(s.price, s.currency)} · {s.durationMin} min</p>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-2">
              {products.map(p => (
                <button key={p.id} disabled={p.stock <= 0} onClick={() => addProduct(p)} aria-label={p.stock > 0 ? `Add ${p.name} to cart` : `${p.name} is out of stock`} className="text-left rounded-2xl border border-black/5 bg-white p-3 hover:border-[#0071e3]/40 hover:shadow-sm transition-all disabled:cursor-not-allowed disabled:bg-black/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]">
                  <div className="flex items-center justify-between gap-2"><p className="font-medium text-sm">{p.name}</p>{p.stock > 0 ? <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-[#0071e3]"><Plus size={13} aria-hidden="true" />Add</span> : <span className="shrink-0 text-xs font-medium text-[#6E6E73]">Out of stock</span>}</div>
                  <p className="text-xs text-[#6E6E73]">{fmtMoney(p.price, 'KES')} · {p.stock} {p.unit} in stock</p>
                  {productQuantityInCart(p.id) > 0 && <p className="mt-1 text-xs font-semibold text-[#0071e3]">In cart: {productQuantityInCart(p.id)}</p>}
                </button>
              ))}
            </div>
          )}
        </div>

        <Card className="p-5 h-fit sticky top-24">
          <h2 className="font-semibold mb-1">Cart</h2>
          <p className="text-xs text-[#6E6E73] mb-3">Assign each service to the staff member who performed it. Multiple services from different staff = joint work.</p>
          {cart.length === 0 ? <p className="text-sm text-[#6E6E73]">Add services or products to get started.</p> : (
            <div className="space-y-3 mb-4">
              {cart.map(l => (
                <div key={l.key} className="border-b border-black/5 pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium">{l.name}</p>
                      <p className="text-xs text-[#6E6E73]">{fmtMoney(l.price, l.currency)} × {l.qty}</p>
                      {l.type === 'service' && <p className="text-xs text-[#6E6E73]">{l.staffCount || 1} staff · {l.commissionPct || 50}% commission{l.staffName ? ` · ${l.staffName}` : ''}</p>}
                    </div>
                    <button onClick={() => removeLine(l.key)} aria-label={`Remove ${l.name} from cart`} className="text-xs text-[#FF3B30] hover:underline">Remove</button>
                  </div>
                  {l.type === 'product' && (
                    <div className="flex items-center gap-2 mt-1">
                      <label className="text-xs text-[#6E6E73]" htmlFor={`qty-${l.key}`}>Qty</label>
                      <input id={`qty-${l.key}`} type="number" min={1} value={l.qty} onChange={e => setLineQty(l.key, Number(e.target.value))} className="w-16 rounded-lg border border-black/10 px-2 py-1 text-xs" />
                    </div>
                  )}
                  {l.type === 'service' && (
                    <div className="mt-1 space-y-1.5">
                      <Select aria-label={`Assign staff for ${l.name}`} className="text-xs py-1.5" value={l.staffId || ''} onChange={e => setLineStaff(l.key, e.target.value)}>
                        <option value="">Assign staff…</option>
                        {assignableStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                      <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setStaffCount(l.key, l.staffCount === 2 ? 1 : 2)}>{l.staffCount === 2 ? 'Use single staff' : 'Split with co-staff'}</Button>{l.staffCount === 2 && <Button size="sm" variant="secondary" onClick={() => toggleThirdStaff(l.key)}>{l.thirdStaffId !== undefined ? 'Remove third staff' : 'Add third staff'}</Button>}</div>
                      {l.staffCount === 2 && <Select aria-label={`Assign co-staff for ${l.name}`} className="text-xs py-1.5" value={l.coStaffId || ''} onChange={e => setLineCoStaff(l.key, e.target.value)}>
                        <option value="">Assign co-staff...</option>
                        {assignableStaff.filter(s => s.id !== l.staffId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>}
                      {l.thirdStaffId !== undefined && <Select aria-label={`Assign third staff for ${l.name}`} className="text-xs py-1.5" value={l.thirdStaffId} onChange={e => setLineThirdStaff(l.key, e.target.value)}><option value="">Assign third staff...</option>{assignableStaff.filter(s => s.id !== l.staffId && s.id !== l.coStaffId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
                      <Select aria-label={`Assign assistant for ${l.name}`} className="text-xs py-1.5" value={l.helperStaffId || ''} onChange={e => setLineHelper(l.key, e.target.value)}>
                        <option value="">No assistant</option>
                        {assignableStaff.filter(s => s.id !== l.staffId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                      {(l.staffCount === 2 || l.thirdStaffId !== undefined || l.helperStaffId) && <div className="grid grid-cols-2 gap-2">
                        <Field label="Primary earns (KES)" htmlFor={`primary-commission-${l.key}`}><Input id={`primary-commission-${l.key}`} type="number" min={0} value={l.primaryCommission ?? ''} onChange={e => setManualAmount(l.key, 'primaryCommission', Number(e.target.value))} className="py-1.5 text-xs" /></Field>
                        {l.staffCount === 2 && <Field label="Co-staff earns (KES)" htmlFor={`co-commission-${l.key}`}><Input id={`co-commission-${l.key}`} type="number" min={0} value={l.coStaffCommission ?? ''} onChange={e => setManualAmount(l.key, 'coStaffCommission', Number(e.target.value))} className="py-1.5 text-xs" /></Field>}
                        {l.thirdStaffId !== undefined && <Field label="Third staff earns (KES)" htmlFor={`third-commission-${l.key}`}><Input id={`third-commission-${l.key}`} type="number" min={0} value={l.thirdStaffCommission ?? ''} onChange={e => setManualAmount(l.key, 'thirdStaffCommission', Number(e.target.value))} className="py-1.5 text-xs" /></Field>}
                        {l.helperStaffId && <Field label="Assistant fee (KES)" htmlFor={`assistant-fee-${l.key}`}><Input id={`assistant-fee-${l.key}`} type="number" min={0} value={l.assistantPayment ?? 0} onChange={e => setManualAmount(l.key, 'assistantPayment', Number(e.target.value))} className="py-1.5 text-xs" /></Field>}
                      </div>}
                      <div className="grid grid-cols-[1fr_auto] gap-2">
                        <Select aria-label={`Product used for ${l.name}`} className="text-xs py-1.5" value={usagePickerByLine[l.key] || ''} onChange={e => { const value = e.target.value; setUsagePickerByLine(prev => ({ ...prev, [l.key]: value })); if (value) addUsedProduct(l.key, value); }}>
                          <option value="">Add used product…</option>
                          {products.map(product => <option key={product.id} value={product.id}>{product.name} ({product.stock} {product.unit})</option>)}
                        </Select>
                        <span className="text-[11px] text-[#6E6E73] self-center">For braid consumables</span>
                      </div>
                      {(l.consumedProducts || []).length > 0 && <div className="space-y-1">
                        {(l.consumedProducts || []).map(item => (
                          <div key={`${l.key}-${item.productId}`} className="flex items-center gap-2">
                            <span className="text-[11px] text-[#6E6E73] min-w-0 flex-1 truncate">{item.name}</span>
                            <Input type="number" min={1} value={item.qty} onChange={e => setUsedProductQty(l.key, item.productId, Number(e.target.value))} className="w-16 px-2 py-1 text-xs" />
                            <span className="text-[11px] text-[#6E6E73]">{item.unit || 'pcs'}</span>
                            <button type="button" onClick={() => removeUsedProduct(l.key, item.productId)} className="text-[11px] text-[#FF3B30] hover:underline">Remove</button>
                          </div>
                        ))}
                      </div>}
                      {l.staffCount === 2 && <p className="text-xs text-[#6E6E73]">Choose both staff members, then enter each person's exact earnings.</p>}
                      {l.helperStaffId && <p className="text-xs text-[#6E6E73]">Enter the assistant's exact fee above.</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-3">
            <Field label={`Customer${currentStaffId ? ' (required)' : ''}`} htmlFor="pos-customer">
              <Select id="pos-customer" value={customerId} onChange={e => setCustomerId(e.target.value)} className={currentStaffId && !customerId ? 'border-red-500' : ''}>
                {!currentStaffId && <option value="">Walk-in Customer</option>}
                {currentStaffId && !customerId && <option value="">Select a client...</option>}
                {customerOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>

            {(() => {
              const servicesByStaff = new Map<string, { name: string; items: CartLine[]; total: number }>();
              for (const line of cart.filter(l => l.type === 'service')) {
                const staffId = line.staffId || 'unassigned';
                const staffName = line.staffName || 'Unassigned';
                const entry = servicesByStaff.get(staffId) || { name: staffName, items: [], total: 0 };
                entry.items.push(line);
                entry.total += line.price * line.qty;
                servicesByStaff.set(staffId, entry);
              }
              const multiStaff = servicesByStaff.size > 1;
              if (multiStaff && cart.some(l => l.type === 'service')) {
                return (
                  <div className="rounded-xl bg-blue-50 border border-blue-200 p-3">
                    <p className="text-xs font-semibold text-blue-900 mb-2">👥 Joint Work Breakdown</p>
                    <div className="space-y-2">
                      {Array.from(servicesByStaff.values()).map(entry => (
                        <div key={entry.name} className="text-xs">
                          <p className="font-medium text-blue-800">{entry.name}</p>
                          <ul className="ml-2 text-blue-700 space-y-0.5">
                            {entry.items.map(item => (
                              <li key={item.key}>
                                · {item.name} {item.qty > 1 ? `× ${item.qty}` : ''} — {fmtMoney(item.price * item.qty, item.currency)}
                              </li>
                            ))}
                          </ul>
                          <p className="font-semibold text-blue-900 mt-1">Subtotal: {fmtMoney(entry.total, 'KES')}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
              return null;
            })()}
            
            <Field label="Discount %" htmlFor="pos-discount"><Input id="pos-discount" type="number" min={0} max={100} value={discountPct} onChange={e => setDiscountPct(Number(e.target.value))} /></Field>
            <Field label="Promo code (optional)" htmlFor="pos-promo"><Input id="pos-promo" value={promoCode} onChange={e => setPromoCode(e.target.value.toUpperCase())} placeholder="e.g. TUESDAY15" /></Field>
            {customerId && (selectedCustomer?.loyaltyPoints || 0) > 0 && (
              <Field label={`Redeem loyalty points (has ${selectedCustomer?.loyaltyPoints})`} htmlFor="pos-points"><Input id="pos-points" type="number" min={0} max={selectedCustomer?.loyaltyPoints || 0} value={redeemPoints} onChange={e => setRedeemPoints(Number(e.target.value))} /></Field>
            )}
            <Field label="Payment method" htmlFor="pos-payment">
              <Select id="pos-payment" value={paymentMethod} onChange={e => setPaymentMethod(e.target.value)}>
                <option>M-Pesa</option><option>Cash</option><option>Card</option>
              </Select>
            </Field>
            {appointment && paymentMethod !== 'M-Pesa' && <p className="rounded-xl bg-[#0071e3]/10 px-3 py-2 text-sm text-[#0058b0]">{paymentMethod === 'Cash' ? 'Ask the client to pay the receptionist in cash.' : 'Ask the client to present their card to the receptionist.'}</p>}
          </div>

          <div className="border-t border-black/5 mt-4 pt-4 space-y-1 text-sm">
            {appointment && <>
              <div className="flex justify-between"><span>Service fee total</span><span>{fmtMoney(serviceTotal, 'KES')}</span></div>
              <div className="flex justify-between"><span>Service total after discount</span><span>{fmtMoney(serviceTotalAfterDiscount, 'KES')}</span></div>
              <div className="flex justify-between"><span>Products total</span><span>{fmtMoney(productTotal, 'KES')}</span></div>
              <div className="flex justify-between"><span>Service products used</span><span>-{fmtMoney(serviceProductCost, 'KES')}</span></div>
              <div className="flex justify-between"><span>Assistant compensation</span><span>-{fmtMoney(assistantTotal, 'KES')}</span></div>
              <div className="flex justify-between font-medium"><span>Expected employee income (50%)</span><span>{fmtMoney(expectedIncome, 'KES')}</span></div>
            </>}
            {currencies.length === 0 ? (
              <div className="flex justify-between font-semibold text-base"><span>Total</span><span>{fmtMoney(0, 'KES')}</span></div>
            ) : currencies.map(cur => (
              <div key={cur} className="flex justify-between font-semibold text-base"><span>Total ({cur})</span><span>{fmtMoney(totalByCurrency[cur], cur)}</span></div>
            ))}
          </div>
          <div className="mt-4 flex gap-2"><Button className="flex-1" variant="secondary" onClick={saveDraft} disabled={checkingOut || cart.length === 0}>Save draft</Button>{hasDraft && <Button className="flex-1" variant="secondary" onClick={restoreDraft} disabled={checkingOut}>Restore draft</Button>}</div>
          <Button className="w-full mt-2" onClick={checkout} disabled={checkingOut || cart.length === 0 || (currentStaffId && !customerId)}>{checkingOut ? 'Processing…' : paymentMethod === 'M-Pesa' && (totalByCurrency.KES || 0) > 0 ? 'Pay with M-Pesa' : 'Charge'}</Button>
        </Card>
      </div>

      {showPay && (
        <MpesaPayModal
          amountKES={totalByCurrency.KES || 0}
          purpose="pos_sale"
          initialPhone={selectedCustomer?.phone}
          onClose={() => setShowPay(false)}
          onSuccess={(receipt) => doCheckout(receipt)}
        />
      )}

      {receipt && (
        <Modal title="Payment Successful" onClose={() => setReceipt(null)} footer={<Button onClick={() => setReceipt(null)}>Done</Button>}>
          <div className="space-y-3 text-sm">
            <p className="text-[#6E6E73]">Receipt #{receipt.id?.slice(0, 8)} · {receipt.paymentMethod}</p>
            <p className="font-medium">{receipt.customerName}</p>
            
            {(() => {
              const itemsByStaff = new Map<string, CartLine[]>();
              for (const item of receipt.items) {
                const staffKey = item.staffName || 'No staff assigned';
                const items = itemsByStaff.get(staffKey) || [];
                items.push(item);
                itemsByStaff.set(staffKey, items);
              }
              if (itemsByStaff.size > 1 && receipt.items.some((i: CartLine) => i.type === 'service')) {
                return (
                  <div className="rounded-lg bg-blue-50 border border-blue-200 p-2">
                    <p className="text-xs font-semibold text-blue-900 mb-2">👥 Joint Work Summary</p>
                    <ul className="space-y-1 text-xs">
                      {Array.from(itemsByStaff.entries()).map(([staff, items]) => (
                        <li key={staff}>
                          <p className="font-medium text-blue-800">{staff}</p>
                          <ul className="ml-2 text-blue-700">
                            {items.filter(i => i.type === 'service').map((item, idx) => (
                              <li key={idx}>· {item.name} {item.qty > 1 ? `× ${item.qty}` : ''} — {fmtMoney(item.price * item.qty, item.currency)}</li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              }
              return null;
            })()}
            
            <ul className="divide-y divide-black/5">
              {receipt.items.map((l: CartLine) => (
                <li key={l.key} className="py-2 flex justify-between"><span>{l.name} × {l.qty}</span><span>{fmtMoney(l.price * l.qty, l.currency)}</span></li>
              ))}
            </ul>
            <div className="border-t border-black/5 pt-3 space-y-1">
              {Object.keys(receipt.totalByCurrency || {}).map(cur => (
                <div key={cur} className="flex justify-between font-semibold"><span>Total Paid ({cur})</span><span>{fmtMoney(receipt.totalByCurrency[cur], cur)}</span></div>
              ))}
            </div>
            {receipt.discountSource && receipt.discountSource !== 'none' && <p className="text-xs text-[#6E6E73]">Discount applied via {receipt.discountSource}.</p>}
            {receipt.pointsRedeemed > 0 && <p className="text-xs text-[#6E6E73]">{receipt.pointsRedeemed} loyalty points redeemed.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default POS;
