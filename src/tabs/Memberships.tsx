import { useEffect, useState } from 'react';
import { Plus, CreditCard } from 'lucide-react';
import { Card, Button, Modal, Field, Input, Textarea, EmptyState, LoadingState, toast } from '../components/ui';
import { MembershipsApi, fmtMoney } from '../lib/api';
import type { MembershipPlan } from '../types';

function Memberships() {
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', discountPct: 5, priceKES: 1000, durationDays: 30, benefitsText: '' });

  const load = () => { MembershipsApi.list().then(setPlans).catch(() => toast('Could not load membership plans.', 'error')).finally(() => setLoading(false)); };
  useEffect(load, []);

  const addPlan = async () => {
    if (!form.name.trim()) { toast('Plan name is required.', 'error'); return; }
    const benefits = form.benefitsText.split('\n').map(b => b.trim()).filter(Boolean);
    await MembershipsApi.create({ name: form.name, discountPct: form.discountPct, priceKES: form.priceKES, durationDays: form.durationDays, benefits });
    toast('Membership plan created.', 'success');
    setOpen(false);
    setForm({ name: '', discountPct: 5, priceKES: 1000, durationDays: 30, benefitsText: '' });
    load();
  };

  if (loading) return <LoadingState label="Loading membership plans…" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Memberships</h1><p className="text-sm text-[#6E6E73]">Design tiers your customers can join for discounts and perks. Assign a tier to any customer from the Customers tab.</p></div>
        <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />New Plan</Button>
      </div>

      {plans.length === 0 ? <EmptyState icon={CreditCard} title="No membership plans yet" description="Create Bronze, Silver, Gold or your own tiers." /> : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans.map(p => (
            <Card key={p.id} className="p-5">
              <p className="font-semibold text-lg">{p.name}</p>
              <p className="text-sm text-[#6E6E73] mt-1">{fmtMoney(p.priceKES, 'KES')} / {p.durationDays} days · {p.discountPct}% off every visit</p>
              {p.benefits.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm text-[#6E6E73] list-disc list-inside">
                  {p.benefits.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}

      {open && (
        <Modal title="New Membership Plan" onClose={() => setOpen(false)} footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={addPlan}>Create Plan</Button>
        </>}>
          <div className="space-y-4">
            <Field label="Plan name" htmlFor="m-name"><Input id="m-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Gold" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Discount %" htmlFor="m-disc"><Input id="m-disc" type="number" min={0} max={100} value={form.discountPct} onChange={e => setForm(f => ({ ...f, discountPct: Number(e.target.value) }))} /></Field>
              <Field label="Price (KES)" htmlFor="m-price"><Input id="m-price" type="number" min={0} value={form.priceKES} onChange={e => setForm(f => ({ ...f, priceKES: Number(e.target.value) }))} /></Field>
            </div>
            <Field label="Duration (days)" htmlFor="m-dur"><Input id="m-dur" type="number" min={1} value={form.durationDays} onChange={e => setForm(f => ({ ...f, durationDays: Number(e.target.value) }))} /></Field>
            <Field label="Benefits (one per line)" htmlFor="m-benefits"><Textarea id="m-benefits" rows={4} value={form.benefitsText} onChange={e => setForm(f => ({ ...f, benefitsText: e.target.value }))} placeholder="Priority booking&#10;Birthday reward&#10;Exclusive offers" /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Memberships;
