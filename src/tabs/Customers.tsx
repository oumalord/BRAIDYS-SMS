import { useEffect, useState } from 'react';
import { Plus, Search, Contact as ContactIcon } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, Textarea, EmptyState, LoadingState, toast } from '../components/ui';
import { CustomersApi, MembershipsApi, fmtKES } from '../lib/api';
import type { Customer, MembershipPlan } from '../types';

function CustomersTab() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '', notes: '' });
  const [plans, setPlans] = useState<MembershipPlan[]>([]);

  const load = () => { CustomersApi.list().then(setCustomers).catch(() => toast('Could not load customers.', 'error')).finally(() => setLoading(false)); };
  useEffect(load, []);
  useEffect(() => { MembershipsApi.list().then(setPlans); }, []);

  const setMembership = async (c: Customer, tier: string) => {
    const plan = plans.find(p => p.name === tier);
    const expiry = tier === 'none' ? null : Date.now() + (plan?.durationDays || 30) * 24 * 3600 * 1000;
    await CustomersApi.update(c.id, { membershipTier: tier, membershipExpiry: expiry });
    toast(tier === 'none' ? 'Membership removed.' : `${c.name} is now a ${tier} member.`, 'success');
    load();
  };

  const addCustomer = async () => {
    if (!form.name.trim() || !form.phone.trim()) { toast('Name and phone are required.', 'error'); return; }
    await CustomersApi.create({ ...form, loyaltyPoints: 0, totalSpent: 0, visits: 0, lastVisit: null });
    toast('Customer added.', 'success');
    setOpen(false);
    setForm({ name: '', phone: '', email: '', notes: '' });
    load();
  };

  const filtered = customers.filter(c => c.name.toLowerCase().includes(query.toLowerCase()) || c.phone.includes(query));

  if (loading) return <LoadingState label="Loading customers…" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">Customers</h1><p className="text-sm text-[#6E6E73]">{customers.length} customers on file</p></div>
        <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />Add Customer</Button>
      </div>

      <div className="relative max-w-sm">
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#6E6E73]" aria-hidden="true" />
        <Input aria-label="Search customers" placeholder="Search by name or phone…" value={query} onChange={e => setQuery(e.target.value)} className="pl-10" />
      </div>

      {filtered.length === 0 ? <EmptyState icon={ContactIcon} title="No customers found" description="Try a different search, or add a new customer." /> : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(c => (
            <Card key={c.id} className="p-5">
              <div className="flex items-start justify-between mb-2">
                <div>
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-[#6E6E73]">{c.phone}</p>
                </div>
                <Badge tone="info">{c.loyaltyPoints} pts</Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm mt-3">
                <div><p className="text-[#6E6E73] text-xs">Total Spent</p><p className="font-medium">{fmtKES(c.totalSpent)}</p></div>
                <div><p className="text-[#6E6E73] text-xs">Visits</p><p className="font-medium">{c.visits}</p></div>
              </div>
              <p className="text-xs text-[#6E6E73] mt-3">Last visit: {c.lastVisit ? new Date(c.lastVisit).toLocaleDateString() : 'No visits yet'}</p>
              {c.notes && <p className="text-xs text-[#6E6E73] mt-2 border-t border-black/5 pt-2">{c.notes}</p>}
              <div className="mt-3 pt-3 border-t border-black/5 flex items-center justify-between gap-2">
                <Badge tone={c.membershipTier && c.membershipTier !== 'none' ? 'success' : 'neutral'}>{c.membershipTier && c.membershipTier !== 'none' ? `${c.membershipTier} member` : 'Non-member'}</Badge>
                <Select aria-label={`Membership for ${c.name}`} value={c.membershipTier || 'none'} onChange={e => setMembership(c, e.target.value)} className="text-xs py-1" style={{ width: 'auto' }}>
                  <option value="none">Non-member</option>
                  {plans.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                </Select>
              </div>
            </Card>
          ))}
        </div>
      )}

      {open && (
        <Modal title="Add Customer" onClose={() => setOpen(false)} footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={addCustomer}>Add Customer</Button>
        </>}>
          <div className="space-y-4">
            <Field label="Full name" htmlFor="c-name"><Input id="c-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Phone" htmlFor="c-phone"><Input id="c-phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+254…" /></Field>
            <Field label="Email (optional)" htmlFor="c-email"><Input id="c-email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></Field>
            <Field label="Notes (optional)" htmlFor="c-notes"><Textarea id="c-notes" rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Preferences, allergies, style notes…" /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default CustomersTab;
