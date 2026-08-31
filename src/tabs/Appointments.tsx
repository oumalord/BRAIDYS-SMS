import { useEffect, useState } from 'react';
import { Plus, Calendar, Clock, Pencil, Trash2 } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, EmptyState, LoadingState, toast } from '../components/ui';
import { AppointmentsApi, StaffApi, ServicesApi, CustomersApi, OrdersApi, fmtKES, fmtMoney } from '../lib/api';
import POS from './POS';
import type { Appointment, Staff, ServiceItem, Customer, AppointmentStatus, Role } from '../types';

function todayStr() { return new Date().toISOString().slice(0, 10); }

const STATUS_FLOW: Record<AppointmentStatus, AppointmentStatus | null> = {
  pending: 'confirmed', confirmed: 'checked-in', 'checked-in': 'in-service', 'in-service': 'completed', completed: null, cancelled: null, 'no-show': null,
};

const STATUS_TONE: Record<AppointmentStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  pending: 'neutral', confirmed: 'info', 'checked-in': 'warning', 'in-service': 'warning', completed: 'success', cancelled: 'danger', 'no-show': 'danger',
};

interface CompletionLine {
  index: number;
  name: string;
  staffId: string;
  coStaffId: string;
  serviceFee: number;
  hasSpecialBraid: boolean;
  helperStaffId: string;
  assistantPayment: number;
  commissionBase: number;
  commissionPct: number;
  primaryCommission: number;
  coStaffCommission: number;
}

function assistantCompensation(serviceFee: number, hasSpecialBraid = false): number {
  if (hasSpecialBraid) return 400;
  if (serviceFee <= 1800) return 200;
  if (serviceFee <= 2400) return 300;
  if (serviceFee <= 3300) return 400;
  return 500;
}

function canAssignStaff(member: Staff) {
  return member.employmentStatus !== 'laid-off' && member.status !== 'off';
}

function Appointments({ role }: { role: Role }) {
  const [date, setDate] = useState(todayStr());
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ customerId: '', customerName: '', customerPhone: '', customerEmail: '', serviceId: '', staffId: '', time: '10:00', cardNumber: '' });
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [editForm, setEditForm] = useState({ serviceId: '', date: '', time: '', staffId: '', cardNumber: '' });
  const [checkoutAppointment, setCheckoutAppointment] = useState<Appointment | null>(null);
  const [completionEdit, setCompletionEdit] = useState<{ orderId: string; appointment: Appointment } | null>(null);
  const [completionLines, setCompletionLines] = useState<CompletionLine[]>([]);
  const [completionSummary, setCompletionSummary] = useState<{ appointment: Appointment; order: any } | null>(null);

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
        date, time: form.time, durationMin: service.durationMin, price: service.price, cardNumber: form.cardNumber,
      });
      toast(`Appointment booked. Payment can be collected at the salon. Ticket ${data.ticketNumber} created.`, 'success');
      setOpen(false);
      setForm({ customerId: '', customerName: '', customerPhone: '', customerEmail: '', serviceId: '', staffId: '', time: '10:00', cardNumber: '' });
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
    if (next === 'completed') { setCheckoutAppointment(a); return; }
    try {
      await AppointmentsApi.update(a.id, { status: next });
      reload();
    } catch (cause: any) {
      toast(cause?.message || `Could not mark as ${next}.`, 'error');
    }
  };
  const setStatus = async (a: Appointment, status: AppointmentStatus) => {
    await AppointmentsApi.update(a.id, { status });
    reload();
  };
  const deleteCancelled = async () => {
    const cancelledCount = appts.filter(appointment => appointment.status === 'cancelled').length;
    if (!cancelledCount || !window.confirm(`Delete all ${cancelledCount} cancelled appointment${cancelledCount === 1 ? '' : 's'} for this view? This cannot be undone.`)) return;
    setSaving(true);
    try {
      const { data } = await AppointmentsApi.deleteCancelled();
      toast(`${data.deleted} cancelled appointment${data.deleted === 1 ? '' : 's'} deleted.`, 'success');
      reload();
    } catch (cause: any) {
      toast(cause?.message || 'Could not delete cancelled appointments.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const beginEdit = (appointment: Appointment) => {
    setEditing(appointment);
    setEditForm({ serviceId: appointment.serviceId || '', date: appointment.date, time: appointment.time === '00:00' ? '' : appointment.time, staffId: appointment.staffId || '', cardNumber: appointment.cardNumber || '' });
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
        cardNumber: editForm.cardNumber,
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

  const beginCompletionEdit = async (appointment: Appointment) => {
    try {
      const order = await OrdersApi.completion(appointment.id);
      const lines = (Array.isArray(order.items) ? order.items : [])
        .map((item: any, index: number) => ({ item, index }))
        .filter(({ item }: { item: any }) => item.type === 'service')
        .map(({ item, index }: { item: any; index: number }) => { const serviceFee = Number(item.price || 0) * Number(item.qty || 1); const hasSpecialBraid = (item.consumedProducts || []).some((product: any) => ['amara', 'diani'].includes(String(product?.name || '').trim().toLowerCase())); const assistantPayment = Number(item.assistantPayment ?? item.helperDeduction ?? 0); const commissionBase = Math.max(0, Number(item.lineTotalAfterDiscount ?? serviceFee) - Number(item.productCost || 0) - assistantPayment); const defaultCommission = commissionBase * (Number(item.commissionPct ?? item.commissionRate ?? 50) / 100); return { index, name: item.name || appointment.serviceName, staffId: item.staffId || '', coStaffId: item.coStaffId || '', serviceFee, hasSpecialBraid, helperStaffId: item.helperStaffId || '', assistantPayment, commissionBase, commissionPct: Number(item.commissionPct ?? item.commissionRate ?? 50), primaryCommission: Number(item.primaryCommission ?? item.commission ?? defaultCommission), coStaffCommission: Number(item.coStaffCommission ?? (item.coStaffId ? item.commission ?? defaultCommission : 0)) }; });
      if (!lines.length) { toast('This appointment has no completed service work to adjust.', 'error'); return; }
      setCompletionLines(lines);
      setCompletionEdit({ orderId: order.id, appointment });
    } catch (cause: any) {
      toast(cause?.message || 'Could not load the completed work record.', 'error');
    }
  };

  const showCompletionSummary = async (appointment: Appointment) => {
    try {
      const order = await OrdersApi.completion(appointment.id);
      setCompletionSummary({ appointment, order });
    } catch (cause: any) {
      toast(cause?.message || 'Could not load the completed deal summary.', 'error');
    }
  };

  const removeAppointment = async (appointment: Appointment) => {
    if (!window.confirm(`Delete ${appointment.customerName}'s ${appointment.status} appointment?${appointment.status === 'completed' ? ' The completed deal stays in financial history.' : ''}`)) return;
    setSaving(true);
    try {
      await AppointmentsApi.remove(appointment.id);
      toast('Appointment deleted.', 'success');
      reload();
    } catch (cause: any) {
      toast(cause?.message || 'Could not delete the appointment.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const reopenCompletedDeal = async (appointment: Appointment) => {
    if (!window.confirm(`Undo ${appointment.customerName}'s completed deal? The recorded sale will be voided, product stock restored, and the appointment returned to in service.`)) return;
    setSaving(true);
    try {
      await AppointmentsApi.reopenCompleted(appointment.id);
      toast('Completed deal undone. The appointment is now in service and ready to correct.', 'success');
      reload();
    } catch (cause: any) {
      toast(cause?.message || 'Could not reopen the completed deal.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveCompletionEdit = async () => {
    if (!completionEdit) return;
    if (completionLines.some(line => !line.staffId || line.assistantPayment < 0 || line.primaryCommission < 0 || line.coStaffCommission < 0 || line.primaryCommission + line.coStaffCommission > line.commissionBase)) { toast('Assign staff and keep combined commissions within the service balance.', 'error'); return; }
    setSaving(true);
    try {
      await OrdersApi.updateCompletion(completionEdit.orderId, { items: completionLines });
      toast('Completed work and commission totals updated.', 'success');
      setCompletionEdit(null);
      reload();
    } catch (cause: any) {
      toast(cause?.message || 'Could not update completed work.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const orderByBookingTime = ['owner', 'admin', 'receptionist'].includes(role);
  const sorted = [...appts].sort((a, b) => {
    const bookingDifference = Number(b.createdAt || 0) - Number(a.createdAt || 0);
    return orderByBookingTime && bookingDifference !== 0 ? bookingDifference : b.time.localeCompare(a.time);
  });
  let account: { staffId?: string } | null = null;
  try { account = JSON.parse(window.localStorage.getItem('safigroom_account') || 'null'); } catch { account = null; }
  const assignableStaff = staff.filter(canAssignStaff);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Appointments</h1>
          <p className="text-sm text-[#6E6E73]">Calendar for {date}{orderByBookingTime ? ' · newest bookings first' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <Field label="Date" htmlFor="date-picker"><Input id="date-picker" type="date" value={date} onChange={e => setDate(e.target.value)} aria-label="Select date" /></Field>
          {(role === 'owner' || role === 'admin') && appts.some(appointment => appointment.status === 'cancelled') && <Button variant="danger" onClick={deleteCancelled} disabled={saving}><Trash2 size={16} aria-hidden="true" />Delete canceled</Button>}
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
                  <p className="text-sm text-[#6E6E73]">{a.serviceName} · {a.staffName || 'Awaiting employee assignment'} · {fmtKES(a.price)}{a.cardNumber ? ` · Card ${a.cardNumber}` : ''}</p>
              </div>
              <Badge tone={STATUS_TONE[a.status]}>{a.status.replace('-', ' ')}</Badge>
              {(role === 'owner' || role === 'admin' || role === 'receptionist' || (role === 'barber' && a.staffId === account?.staffId)) && <div className="flex flex-wrap gap-2">
                {(role === 'owner' || (role === 'admin' && !['completed', 'cancelled', 'no-show'].includes(a.status))) && <Button size="sm" variant="secondary" onClick={() => beginEdit(a)}><Pencil size={14} aria-hidden="true" />Edit</Button>}
                {(role === 'owner' || role === 'admin') && a.status === 'completed' && <Button size="sm" variant="secondary" onClick={() => showCompletionSummary(a)}>Deal summary</Button>}
                {(role === 'owner' || role === 'admin') && a.status === 'completed' && <Button size="sm" variant="secondary" onClick={() => beginCompletionEdit(a)}><Pencil size={14} aria-hidden="true" />Adjust completion</Button>}
                {role === 'owner' && a.status === 'completed' && <Button size="sm" variant="danger" onClick={() => reopenCompletedDeal(a)} disabled={saving}>Undo completed deal</Button>}
                {(role === 'owner' || role === 'admin') && !['completed', 'cancelled', 'no-show'].includes(a.status) && (
                    <Select aria-label={`Assign employee for ${a.customerName}`} value={a.staffId || ''} onChange={e => {
                      const selected = staff.find(s => s.id === e.target.value);
                      AppointmentsApi.update(a.id, { staffId: selected?.id || null, staffName: selected?.name || null }).then(reload);
                    }} className="text-xs py-1.5 w-auto">
                      <option value="">Assign employee</option>
                      {assignableStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                  )}
                {STATUS_FLOW[a.status] && <Button size="sm" variant="secondary" onClick={() => advance(a)}>{STATUS_FLOW[a.status] === 'completed' ? 'Open POS & complete' : `Mark ${STATUS_FLOW[a.status]?.replace('-', ' ')}`}</Button>}
                {!['completed', 'cancelled', 'no-show'].includes(a.status) && <Button size="sm" variant="ghost" onClick={() => setStatus(a, 'no-show')}>No-show</Button>}
                {!['completed', 'cancelled'].includes(a.status) && <Button size="sm" variant="danger" onClick={() => setStatus(a, 'cancelled')}>Cancel</Button>}
                {(role === 'owner' || role === 'admin') && <Button size="sm" variant="danger" onClick={() => removeAppointment(a)}><Trash2 size={14} aria-hidden="true" />Delete</Button>}
              </div>}
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
                {role === 'barber' ? (
                  Array.from(new Map(
                    appts
                      .filter(a => a.staffId === account?.staffId && ['checked-in', 'in-service', 'pending', 'confirmed'].includes(a.status) && a.customerId)
                      .map(a => [a.customerId, { id: a.customerId, name: a.customerName }])
                  ).values()).map(c => <option key={c.id} value={c.id}>{c.name}</option>)
                ) : (
                  customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)
                )}
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
                {assignableStaff.map(s => <option key={s.id} value={s.id}>{s.name} — {s.role}</option>)}
              </Select>
            </Field>
            <Field label="Card number (optional)" htmlFor="appt-card-number"><Input id="appt-card-number" inputMode="numeric" pattern="[0-9]*" value={form.cardNumber} onChange={e => setForm(f => ({ ...f, cardNumber: e.target.value.replace(/\D/g, '') }))} placeholder="Unique for this day" /></Field>
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
            <Field label="Employee" htmlFor="edit-appt-staff"><Select id="edit-appt-staff" value={editForm.staffId} onChange={e => setEditForm(current => ({ ...current, staffId: e.target.value }))}><option value="">Assign later</option>{assignableStaff.map(member => <option key={member.id} value={member.id}>{member.name} — {member.role}</option>)}</Select></Field>
            <Field label="Card number" htmlFor="edit-appt-card-number"><Input id="edit-appt-card-number" inputMode="numeric" pattern="[0-9]*" value={editForm.cardNumber} disabled={Boolean(editing.cardNumber)} onChange={e => setEditForm(current => ({ ...current, cardNumber: e.target.value.replace(/\D/g, '') }))} placeholder="Enter once; unique for this day" /></Field>
            <div className="grid sm:grid-cols-2 gap-4"><Field label="Date" htmlFor="edit-appt-date"><Input id="edit-appt-date" type="date" value={editForm.date} onChange={e => setEditForm(current => ({ ...current, date: e.target.value }))} /></Field><Field label="Time" htmlFor="edit-appt-time"><Input id="edit-appt-time" type="time" value={editForm.time} onChange={e => setEditForm(current => ({ ...current, time: e.target.value }))} /></Field></div>
          </div>
        </Modal>
      )}

      {completionEdit && (
        <Modal title="Adjust completed work" onClose={() => setCompletionEdit(null)} footer={<>
          <Button variant="secondary" onClick={() => setCompletionEdit(null)}>Cancel</Button>
          <Button onClick={saveCompletionEdit} disabled={saving}>{saving ? 'Saving…' : 'Save completion'}</Button>
        </>}>
          <div className="space-y-4">
            <p className="text-sm text-[#6E6E73]">{completionEdit.appointment.customerName}'s completed services and employee commissions.</p>
            {completionLines.map((line, lineIndex) => (
              <div key={line.index} className="border-b border-black/5 pb-4 space-y-3">
                <p className="text-sm font-medium">{line.name}</p>
                <Field label="Completed by" htmlFor={`completion-staff-${line.index}`}><Select id={`completion-staff-${line.index}`} value={line.staffId} onChange={event => setCompletionLines(current => current.map((item, index) => index === lineIndex ? { ...item, staffId: event.target.value } : item))}><option value="">Assign employee</option>{assignableStaff.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</Select></Field>
                <Field label="Co-staff (optional)" htmlFor={`completion-co-staff-${line.index}`}><Select id={`completion-co-staff-${line.index}`} value={line.coStaffId} onChange={event => setCompletionLines(current => current.map((item, index) => index === lineIndex ? { ...item, coStaffId: event.target.value, coStaffCommission: event.target.value ? item.coStaffCommission : 0 } : item))}><option value="">No co-staff</option>{assignableStaff.filter(member => member.id !== line.staffId && member.id !== line.helperStaffId).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</Select></Field>
                <Field label="Assistant (optional)" htmlFor={`completion-assistant-${line.index}`}><Select id={`completion-assistant-${line.index}`} value={line.helperStaffId} onChange={event => setCompletionLines(current => current.map((item, index) => index === lineIndex ? { ...item, helperStaffId: event.target.value, assistantPayment: event.target.value ? item.assistantPayment || assistantCompensation(item.serviceFee, item.hasSpecialBraid) : 0 } : item))}><option value="">No assistant</option>{assignableStaff.filter(member => member.id !== line.staffId && member.id !== line.coStaffId).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</Select></Field>
                {(line.coStaffId || line.helperStaffId) ? <div className="grid sm:grid-cols-3 gap-4">
                  <Field label="Primary commission (KES)" htmlFor={`completion-primary-${line.index}`}><Input id={`completion-primary-${line.index}`} type="number" min={0} value={line.primaryCommission} onChange={event => setCompletionLines(current => current.map((item, index) => index === lineIndex ? { ...item, primaryCommission: Number(event.target.value) } : item))} /></Field>
                  {line.coStaffId ? <Field label="Co-staff commission (KES)" htmlFor={`completion-co-commission-${line.index}`}><Input id={`completion-co-commission-${line.index}`} type="number" min={0} value={line.coStaffCommission} onChange={event => setCompletionLines(current => current.map((item, index) => index === lineIndex ? { ...item, coStaffCommission: Number(event.target.value) } : item))} /></Field> : <div />}
                  {line.helperStaffId ? <Field label="Assistant fee (KES)" htmlFor={`completion-assistant-payment-${line.index}`}><Input id={`completion-assistant-payment-${line.index}`} type="number" min={0} value={line.assistantPayment} onChange={event => setCompletionLines(current => current.map((item, index) => index === lineIndex ? { ...item, assistantPayment: Number(event.target.value) } : item))} /></Field> : <div />}
                </div> : <p className="text-sm text-[#6E6E73]">Single-staff service: commission is calculated automatically from the configured rate.</p>}
                <p className="text-sm text-[#6E6E73]">Service fee {fmtKES(line.serviceFee)} · costs and assistant fee {fmtKES(line.serviceFee - line.commissionBase)} · available for staff {fmtKES(line.commissionBase)} · allocated {fmtKES(line.primaryCommission + line.coStaffCommission)}</p>
              </div>
            ))}
            <div className="flex justify-between text-sm font-semibold"><span>Total staff commissions</span><span>{fmtKES(completionLines.reduce((sum, line) => sum + line.primaryCommission + line.coStaffCommission, 0))}</span></div>
          </div>
        </Modal>
      )}

      {completionSummary && (
        <Modal title="Completed deal summary" onClose={() => setCompletionSummary(null)} footer={<Button onClick={() => setCompletionSummary(null)}>Done</Button>}>
          <div className="space-y-4 text-sm">
            <div><p className="font-semibold">{completionSummary.appointment.customerName}</p><p className="text-[#6E6E73]">{completionSummary.order.paymentMethod || 'Payment method not recorded'} · {new Date(Number(completionSummary.order.createdAt || Date.now())).toLocaleString()}</p></div>
            <div className="space-y-2 border-y border-black/5 py-3">{(completionSummary.order.items || []).map((item: any, index: number) => { const fee = Number(item.lineTotalAfterDiscount ?? Number(item.price || 0) * Number(item.qty || 1)); const assistantFee = Number(item.assistantPayment ?? item.helperDeduction ?? 0); const available = Math.max(0, fee - Number(item.productCost || 0) - assistantFee); const primaryCommission = Number(item.primaryCommission ?? item.commission ?? 0); const coStaffCommission = Number(item.coStaffCommission ?? (item.coStaffId ? item.commission ?? 0 : 0)); return <div key={`${item.refId}-${index}`}><div className="flex justify-between gap-4"><span>{item.name} × {item.qty || 1}</span><span>{fmtMoney(fee, item.currency || 'KES')}</span></div>{item.type === 'service' && <div className="text-xs text-[#6E6E73]"><p>Available after product and assistant costs: {fmtMoney(available, item.currency || 'KES')}</p><p>{item.staffName || 'Unassigned'}: {fmtMoney(primaryCommission, item.currency || 'KES')}{item.coStaffName ? ` · ${item.coStaffName}: ${fmtMoney(coStaffCommission, item.currency || 'KES')}` : ''}{item.helperStaffName ? ` · Assistant ${item.helperStaffName}: ${fmtMoney(assistantFee, item.currency || 'KES')}` : ''}</p></div>}{(item.consumedProducts || []).length > 0 && <p className="text-xs text-[#6E6E73]">Products used: {item.consumedProducts.map((product: any) => `${product.name} × ${product.qty}`).join(', ')}</p>}</div>})}</div>
            {Object.entries(completionSummary.order.subtotalByCurrency || {}).map(([currency, amount]) => <div key={`subtotal-${currency}`} className="flex justify-between"><span>Subtotal ({currency})</span><span>{fmtMoney(Number(amount), currency)}</span></div>)}
            {Object.entries(completionSummary.order.discountByCurrency || {}).some(([, amount]) => Number(amount) > 0) && <div className="flex justify-between"><span>Discount</span><span>{completionSummary.order.discountPct || 0}%</span></div>}
            {Object.entries(completionSummary.order.totalByCurrency || {}).map(([currency, amount]) => <div key={`total-${currency}`} className="flex justify-between font-semibold"><span>Total ({currency})</span><span>{fmtMoney(Number(amount), currency)}</span></div>)}
          </div>
        </Modal>
      )}

      {checkoutAppointment && <Modal title="Complete appointment" onClose={() => setCheckoutAppointment(null)}><POS appointment={checkoutAppointment} onSaleComplete={() => { setCheckoutAppointment(null); reload(); }} /></Modal>}

    </div>
  );
}

export default Appointments;
