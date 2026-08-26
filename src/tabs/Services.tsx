import { useEffect, useState } from 'react';
import { Pencil, Plus, Tag } from 'lucide-react';
import { Card, Button, Modal, Field, Input, Select, EmptyState, LoadingState, toast } from '../components/ui';
import { ServicesApi, fmtMoney } from '../lib/api';
import type { ServiceItem, Currency, Role } from '../types';

function Services({ role }: { role: Role }) {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', category: '', price: 0, currency: 'KES' as Currency, durationMin: 30, description: '' });

  const load = () => { ServicesApi.list().then(setServices).catch(() => toast('Could not load services.', 'error')).finally(() => setLoading(false)); };
  useEffect(load, []);

  const addService = async () => {
    if (!form.name.trim() || form.price <= 0) { toast('Enter a service name and a price greater than zero.', 'error'); return; }
    await ServicesApi.create(form);
    toast('Service added to the catalog.', 'success');
    setOpen(false);
    setForm({ name: '', category: '', price: 0, currency: 'KES', durationMin: 30, description: '' });
    load();
  };

  const beginEdit = (service: ServiceItem) => {
    setEditId(service.id);
    setForm({
      name: service.name,
      category: service.category,
      price: service.price,
      currency: service.currency,
      durationMin: service.durationMin,
      description: service.description || '',
    });
    setOpen(true);
  };

  const saveEdit = async () => {
    if (!editId) return;
    if (!form.name.trim() || form.price <= 0) { toast('Enter a service name and a price greater than zero.', 'error'); return; }
    await ServicesApi.update(editId, form);
    toast('Service updated.', 'success');
    setOpen(false);
    setEditId(null);
    setForm({ name: '', category: '', price: 0, currency: 'KES', durationMin: 30, description: '' });
    load();
  };

  const categories = Array.from(new Set(services.map(s => s.category)));
  const canEdit = role === 'owner' || role === 'admin';

  if (loading) return <LoadingState label="Loading services…" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Services Catalog</h1><p className="text-sm text-[#6E6E73]">{services.length} services across {categories.length} categories. Owner and admin accounts can edit services after adding them.</p></div>
        <Button onClick={() => { setEditId(null); setOpen(true); }}><Plus size={16} aria-hidden="true" />Add Service</Button>
      </div>

      {services.length === 0 ? <EmptyState icon={Tag} title="No services yet" description="Add your first service to the catalog." /> : (
        <div className="space-y-6">
          {categories.map(cat => (
            <div key={cat}>
              <h2 className="text-xs font-semibold text-[#6E6E73] uppercase tracking-wide mb-2">{cat}</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {services.filter(s => s.category === cat).map(s => (
                  <Card key={s.id} className="p-4">
                    <p className="font-medium text-sm">{s.name}</p>
                    <p className="text-xs text-[#6E6E73] mt-1">{fmtMoney(s.price, s.currency)} · {s.durationMin} min</p>
                    {s.description && <p className="text-xs text-[#6E6E73] mt-2">{s.description}</p>}
                    {canEdit && <div className="mt-3">
                      <Button size="sm" variant="secondary" onClick={() => beginEdit(s)}><Pencil size={14} aria-hidden="true" />Edit</Button>
                    </div>}
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <Modal title={editId ? 'Edit Service' : 'Add Service'} onClose={() => { setOpen(false); setEditId(null); }} footer={<>
          <Button variant="secondary" onClick={() => { setOpen(false); setEditId(null); }}>Cancel</Button>
          <Button onClick={editId ? saveEdit : addService}>{editId ? 'Save Changes' : 'Add Service'}</Button>
        </>}>
          <div className="space-y-4">
            <Field label="Service name" htmlFor="sv-name"><Input id="sv-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Category" htmlFor="sv-cat"><Input id="sv-cat" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="e.g. Barber, Salon, Spa" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Price" htmlFor="sv-price"><Input id="sv-price" type="number" min={0} value={form.price} onChange={e => setForm(f => ({ ...f, price: Number(e.target.value) }))} /></Field>
              <Field label="Currency" htmlFor="sv-currency">
                <Select id="sv-currency" value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value as Currency }))}>
                  <option value="KES">KES</option>
                  <option value="USD">USD</option>
                </Select>
              </Field>
            </div>
            <Field label="Duration (minutes)" htmlFor="sv-dur"><Input id="sv-dur" type="number" min={5} value={form.durationMin} onChange={e => setForm(f => ({ ...f, durationMin: Number(e.target.value) }))} /></Field>
            <Field label="Description (optional)" htmlFor="sv-desc"><Input id="sv-desc" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Services;
