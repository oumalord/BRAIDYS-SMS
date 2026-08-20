import { useEffect, useState } from 'react';
import { Plus, Calendar, Clock, Pencil } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, EmptyState, LoadingState, toast } from '../components/ui';
import { AppointmentsApi, StaffApi, ServicesApi, CustomersApi, fmtKES } from '../lib/api';
import type { Appointment, Staff, ServiceItem, Customer, AppointmentStatus, Role } from '../types';

function todayStr() { return new Date().toISOString().slice(0, 10); }

const STATUS_FLOW: Record<AppointmentStatus, AppointmentStatus | null> = {
  pending: 'confirmed', confirmed: 'checked-in', 'checked-in': 'in-service', 'in-service': 'completed', completed: null, cancelled: null, 'no-show': null,
};

const STATUS_TONE: Record<AppointmentStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending: 'neutral', confirmed: 'info', 'checked-in': 'warning', 'in-service': 'warning', completed: 'success', cancelled: 'danger', 'no-show': 'danger',
};

function Appointments({ role }: { role: Role }) {
  const [date, setDate] = useState(todayStr());
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ customerId: '', customerName: '', customerPhone: '', customerEmail: '', serviceId: '', staffId: '', time: '10:00' });
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [editForm, setEditForm] = useState({ serviceId: '', date: '', time: '', staffId: '' });

  useEffect(() => {
    Promise.all([StaffApi.list(), ServicesApi.list(), CustomersApi.list()]).then(([s, sv, c]) => { setStaff(s); setServices(sv); setCustomers(c); });
  }, []);

  useEffect(() => {
    setLoading(true);
    AppointmentsApi.list(date).then(setAppts).catch(() => toast('Could not load appointments.', 'error')).finally(() => setLoading(false));
  }, [date]);

  const reload = () => {
    AppointmentsApi.list(date).then(setAppts).catch(() => toast('Could not load appointments.', 'error'));
  };

  const doCreate = async () => {
    const service = services.find(s => s.id === form.serviceId);
    const staffMember = staff.find(s => s.id === form.staffId);
    const customer = customers.find(c => c.id === form.customerId);
    if (!service) return;
    setSaving(true);
    try {
      let customerId = customer?.id || null;
      if (!customerId && form.customerName.trim()) {
        const created = await CustomersApi.create({ name: form.customerName, phone: form.customerPhone, email: form.customerEmail, notes: '' });
        customerId = created.data.id;
      }
      const { data } = await AppointmentsApi.create({
        customerId,
        customerName: customer?.name || form.customerName,
        customerEmail: customer?.email || form.customerEmail,
        serviceId: service.id, serviceName: service.name,
        staffId: staffMember?.id || null, staffName: staffMember?.name || null,
        date, time: form.time, durationMin: service.durationMin, price: service.price,
      });
      toast(`Appointment booked. Payment can be collected at the salon. Ticket ${data.ticketNumber} created.`, 'success');
      setOpen(false);
      setForm({ customerId: '', customerName: '', customerPhone: '', customerEmail: '', serviceId: '', staffId: '', time: '10:00' });
      reload();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'That time slot is not available.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async () => {
    const service = services.find(s => s.id === form.serviceId);
    const staffMember = staff.find(s => s.id === form.staffId);
    const customer = customers.find(c => c.id === form.customerId);
    if (!service || (!customer && !form.customerName)) { toast('Please complete the customer and service fields.', 'error'); return; }

    const toMin = (t: string) => { const parts = t.split(':').map(Number); return parts[0] * 60 + parts[1]; };
    const startMin = toMin(form.time);
    const endMin = startMin + service.durationMin;
    const conflict = staffMember && appts.find(a => {
      if (a.staffId !== staffMember.id) return false;
      if (a.status === 'cancelled' || a.status === 'no-show' || a.status === 'completed') return false;
      const s = toMin(a.time);
      const e = s + (a.durationMin || 30);
      return startMin < e && endMin > s;
    });
    if (conflict) { toast(`${staffMember.name} already has an appointment at that time`, 'error'); return; }

    await doCreate();
  };

  const advance = async (a: Appointment) => {
    const next = STATUS_FLOW[a.status];
    if (!next) return;
    await AppointmentsApi.update(a.id, { status: next });
    reload();
  };
  const setStatus = async (a: Appointment, status: AppointmentStatus) => {
    await AppointmentsApi.update(a.id, { status });
    reload();
  };

  const beginEdit = (appointment: Appointment) => {
    setEditing(appointment);
    setEditForm({ serviceId: appointment.serviceId || '', date: appointment.date, time: appointment.time === '00:00' ? '' : appointment.time, staffId: appointment.staffId || '' });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const service = services.find(item => item.id === editForm.serviceId);
    const assigned = staff.find(item => item.id === editForm.staffId);
    if (!service || !editForm.date || !editForm.time) { toast('Choose a service, date and time.', 'error'); return; }
    setSaving(true);
    try {
      await AppointmentsApi.update(editing.id, {
        serviceId: service.id,
        serviceName: service.name,
        price: service.price,
        currency: service.currency,
        durationMin: service.durationMin,
        date: editForm.date,
        time: editForm.time,
        staffId: assigned?.id || null,
        staffName: assigned?.name || null,
      });
      toast('Appointment updated.', 'success');
      setEditing(null);
      reload();
    } catch (cause: any) {
      toast(cause?.message || 'Could not update the appointment.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const sorted = [...appts].sort((a, b) => a.time.localeCompare(b.time));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Appointments</h1>
          <p className="text-sm text-[#6E6E73]">Calendar for {date}</p>
        </div>
        <div className="flex items-center gap-2">
          <Field label="Date" htmlFor="date-picker"><Input id="date-picker" type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Select date" /></Field>
          <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />New Appointment</Button>
        </div>
      </div>

      {loading ? <LoadingState label="Loading appointments…" /> : sorted.length === 0 ? (
        <EmptyState icon={Calendar} title="No appointments" description="There are no appointments scheduled for this date yet." action={<Button onClick={() => setOpen(true)}>Book an appointment</Button>} />
      ) : (
        <div className="space-y-3">
          {sorted.map(a => (
            <Card key={a.id} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
              <div className="flex items-center gap-2 text-sm font-medium w-24"><Clock size={14} aria-hidden="true" className="text-[#6E6E73]" />{a.time}</div>
              <div className="flex-1">
                <p className="font-medium">{a.customerName}</p>
                  <p className="text-sm text-[#6E6E73]">{a.serviceName} · {a.staffName || 'Awaiting employee assignment'} · {fmtKES(a.price)}</p>
              </div>
              <Badge tone={STATUS_TONE[a.status]}>{a.status.replace('-', ' ')}</Badge>
              <div className="flex flex-wrap gap-2">
                {role === 'owner' || role === 'receptionist' ? (!['completed', 'cancelled', 'no-show'].includes(a.status) && <Button size="sm" variant="secondary" onClick={() => beginEdit(a)}><Pencil size={14} aria-hidden="true" />Edit</Button>) : null}
                  {!['completed', 'cancelled', 'no-show'].includes(a.status) && (
                    <Select aria-label={`Assign employee for ${a.customerName}`} value={a.staffId || ''} onChange={e => {
                      const selected = staff.find(s => s.id === e.target.value);
                      AppointmentsApi.update(a.id, { staffId: selected?.id || null, staffName: selected?.name || null }).then(reload);
                    }} className="text-xs py-1.5 w-auto">
                      <option value="">Assign employee</option>
                      {staff.filter(s => s.status === 'available' || s.id === a.staffId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                  )}
                {STATUS_FLOW[a.status] && <Button size="sm" variant="secondary" onClick={() => advance(a)}>Mark {STATUS_FLOW[a.status]?.replace('-', ' ')}</Button>}
                {!['completed', 'cancelled', 'no-show'].includes(a.status) && <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'no-show')}>No-show</Button>}
                {!['completed', 'cancelled'].includes(a.status) && <Button size="sm" variant="danger" onClick={() => setStatus(a, 'cancelled')}>Cancel</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {open && (
        <Modal title="New Appointment" onClose={() => setOpen(false)} footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleCreate} disabled={saving}>{saving ? 'Booking…' : 'Book Appointment'}</Button>
        </>}>
          <div className="space-y-4">
            <Field label="Customer" htmlFor="appt-customer">
              <Select id="appt-customer" value={form.customerId} onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))}>
                <option value="">— New / walk-in customer —</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            {!form.customerId && (
              <>
                <Field label="Customer name" htmlFor="appt-customer-name">
                  <Input id="appt-customer-name" value={form.customerName} onChange={e => setForm(f => ({ ...f, customerName: e.target.value }))} placeholder="Full name" />
                </Field>
                <Field label="Customer phone" htmlFor="appt-customer-phone">
                  <Input id="appt-customer-phone" value={form.customerPhone} onChange={e => setForm(f => ({ ...f, customerPhone: e.target.value }))} placeholder="0712345678" />
                </Field>
                <Field label="Customer email (for ticket notification)" htmlFor="appt-customer-email">
                  <Input id="appt-customer-email" type="email" value={form.customerEmail} onChange={e => setForm(f => ({ ...f, customerEmail: e.target.value }))} placeholder="customer@example.com" />
                </Field>
              </>
            )}
            <Field label="Service" htmlFor="appt-service">
              <Select id="appt-service" value={form.serviceId} onChange={e => setForm(f => ({ ...f, serviceId: e.target.value }))}>
                <option value="">Select a service</option>
                {services.map(s => <option key={s.id} value={s.id}>{s.name} — {fmtKES(s.price)} ({s.durationMin} min)</option>)}
              </Select>
            </Field>
            <Field label="Employee (optional; receptionist can assign later)" htmlFor="appt-staff">
              <Select id="appt-staff" value={form.staffId} onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))}>
                <option value="">Assign later</option>
                {staff.filter(s => s.status === 'available').map(s => <option key={s.id} value={s.id}>{s.name} — {s.role}</option>)}
              </Select>
            </Field>
            <Field label="Time" htmlFor="appt-time">
              <Input id="appt-time" type="time" value={form.time} onChange={e => setForm(f => ({ ...f, time: e.target.value }))} />
            </Field>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title="Edit appointment" onClose={() => setEditing(null)} footer={<>
          <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={saveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
        </>}>
          <div className="space-y-4">
            <p className="text-sm text-[#6E6E73]">Editing {editing.customerName}'s appointment.</p>
            <Field label="Service" htmlFor="edit-appt-service"><Select id="edit-appt-service" value={editForm.serviceId} onChange={e => setEditForm(current => ({ ...current, serviceId: e.target.value }))}>{services.map(service => <option key={service.id} value={service.id}>{service.name} — {fmtKES(service.price)} ({service.durationMin} min)</option>)}</Select></Field>
            <Field label="Employee" htmlFor="edit-appt-staff"><Select id="edit-appt-staff" value={editForm.staffId} onChange={e => setEditForm(current => ({ ...current, staffId: e.target.value }))}><option value="">Assign later</option>{staff.filter(member => member.status === 'available' || member.id === editing.staffId).map(member => <option key={member.id} value={member.id}>{member.name} — {member.role}</option>)}</Select></Field>
            <div className="grid sm:grid-cols-2 gap-4"><Field label="Date" htmlFor="edit-appt-date"><Input id="edit-appt-date" type="date" value={editForm.date} onChange={e => setEditForm(current => ({ ...current, date: e.target.value }))} /></Field><Field label="Time" htmlFor="edit-appt-time"><Input id="edit-appt-time" type="time" value={editForm.time} onChange={e => setEditForm(current => ({ ...current, time: e.target.value }))} /></Field></div>
          </div>
        </Modal>
      )}

    </div>
  );
}

export default Appointments;
