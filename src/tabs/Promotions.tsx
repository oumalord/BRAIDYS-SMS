import { useEffect, useState } from 'react';
import { Mail, Plus, Percent } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, EmptyState, LoadingState, toast } from '../components/ui';
import { PromotionsApi } from '../lib/api';
import type { Promotion, Role } from '../types';

function Promotions({ role }: { role: Role }) {
  const [promos, setPromos] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', code: '', discountPct: 10, startDate: '', endDate: '', requiresApproval: false });

  const load = () => { PromotionsApi.list().then(setPromos).catch(() => toast('Could not load promotions.', 'error')).finally(() => setLoading(false)); };
  useEffect(load, []);

  const addPromo = async () => {
    if (!form.title.trim() || !form.code.trim()) { toast('Title and code are required.', 'error'); return; }
    await PromotionsApi.create({ ...form, createdBy: role });
    toast('Promotion created.', 'success');
    setOpen(false);
    setForm({ title: '', description: '', code: '', discountPct: 10, startDate: '', endDate: '', requiresApproval: false });
    load();
  };

  const approve = async (p: Promotion) => { await PromotionsApi.update(p.id, { approved: true }); load(); };
  const toggleActive = async (p: Promotion) => { await PromotionsApi.update(p.id, { active: !p.active }); load(); };
  const emailCustomers = async (p: Promotion) => {
    try {
      const { data } = await PromotionsApi.emailCustomers(p.id);
      toast(`${data.sent} customer emails ${data.delivery === 'sent' ? 'sent' : 'queued'}.`, 'success');
      load();
    } catch (cause: any) {
      toast(cause?.message || 'Could not send the promotion email.', 'error');
    }
  };

  if (loading) return <LoadingState label="Loading promotions…" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Promotions</h1><p className="text-sm text-[#6E6E73]">Create discount codes for reception to apply at checkout. Codes needing approval stay inactive until the owner approves them.</p></div>
        {role === 'owner' && <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />New Promotion</Button>}
      </div>

      {promos.length === 0 ? <EmptyState icon={Percent} title="No promotions yet" description="Create a discount code to run your first promotion." /> : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {promos.map(p => (
            <Card key={p.id} className="p-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-semibold">{p.title}</p>
                  <p className="text-xs text-[#6E6E73] mt-0.5">Code: <span className="font-mono font-medium">{p.code}</span> · {p.discountPct}% off</p>
                </div>
                <Badge tone={p.active && p.approved ? 'success' : p.requiresApproval && !p.approved ? 'warning' : 'neutral'}>{p.active && p.approved ? 'Live' : p.requiresApproval && !p.approved ? 'Pending approval' : 'Inactive'}</Badge>
              </div>
              {p.description && <p className="text-sm text-[#6E6E73] mt-2">{p.description}</p>}
              {(p.startDate || p.endDate) && <p className="text-xs text-[#6E6E73] mt-2">{p.startDate || 'Any date'} → {p.endDate || 'No end date'}</p>}
              {role === 'owner' && (
                <div className="flex gap-2 mt-3">
                  {p.requiresApproval && !p.approved && <Button size="sm" onClick={() => approve(p)}>Approve</Button>}
                  <Button size="sm" variant="secondary" onClick={() => toggleActive(p)}>{p.active ? 'Deactivate' : 'Reactivate'}</Button>
                  <Button size="sm" variant="secondary" onClick={() => emailCustomers(p)}><Mail size={14} aria-hidden="true" />Email customers</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {open && (
        <Modal title="New Promotion" onClose={() => setOpen(false)} footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={addPromo}>Create Promotion</Button>
        </>}>
          <div className="space-y-4">
            <Field label="Title" htmlFor="pr-title"><Input id="pr-title" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Tuesday Barber Special" /></Field>
            <Field label="Description (optional)" htmlFor="pr-desc"><Input id="pr-desc" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" htmlFor="pr-code"><Input id="pr-code" value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="TUESDAY15" /></Field>
              <Field label="Discount %" htmlFor="pr-disc"><Input id="pr-disc" type="number" min={0} max={100} value={form.discountPct} onChange={e => setForm(f => ({ ...f, discountPct: Number(e.target.value) }))} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date (optional)" htmlFor="pr-start"><Input id="pr-start" type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} /></Field>
              <Field label="End date (optional)" htmlFor="pr-end"><Input id="pr-end" type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.requiresApproval} onChange={e => setForm(f => ({ ...f, requiresApproval: e.target.checked }))} className="rounded" />
              Requires owner approval before going live
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Promotions;
