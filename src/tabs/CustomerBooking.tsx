import { useEffect, useState } from 'react';
import { CalendarCheck, Ticket } from 'lucide-react';
import { AppointmentsApi, StaffApi } from '../lib/api';
import { Card, Button, Field, Input, Select, toast } from '../components/ui';
import type { Staff } from '../types';

function CustomerBooking({ account }: { account: { id: string; name: string; email: string; phone?: string; branchId?: string } }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [form, setForm] = useState({ serviceCategories: [] as string[], staffId: '', date: new Date().toISOString().slice(0, 10) });
  const [saving, setSaving] = useState(false);
  const [ticket, setTicket] = useState<{ ticketNumber: string; date: string; time: string } | null>(null);

  useEffect(() => {
    StaffApi.list().then(loadedStaff => {
      setStaff(loadedStaff);
    }).catch(() => toast('Could not load booking options.', 'error'));
  }, []);

  const serviceCategories = ['Salon', 'Barber', 'Spa', 'Nails'];
  const availableStaff = staff.filter(member => member.status === 'available');

  const toggleCategory = (category: string) => setForm(current => ({ ...current, serviceCategories: current.serviceCategories.includes(category) ? current.serviceCategories.filter(item => item !== category) : current.serviceCategories.length < 2 ? [...current.serviceCategories, category] : current.serviceCategories }));

  const book = async () => {
    if (form.serviceCategories.length === 0) {
      toast('Choose at least one service category.', 'error');
      return;
    }
    setSaving(true);
    try {
      const assigned = staff.find(member => member.id === form.staffId);
      const { data } = await AppointmentsApi.create({
        customerId: account.id,
        customerName: account.name,
        customerEmail: account.email,
        customerPhone: account.phone || '',
        branchId: account.branchId,
        date: form.date,
        serviceCategories: form.serviceCategories,
        staffId: assigned?.id || null,
        staffName: assigned?.name || null,
      });
      setTicket({ ticketNumber: data.ticketNumber, date: data.date || 'Pending scheduling', time: data.time || 'Reception will confirm' });
      toast('Booking request sent. Reception will assign the exact service and confirm the time.', 'success');
    } catch (cause: any) {
      toast(cause?.message || 'Could not complete the booking.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    void book();
  };

  if (ticket) return (
    <div className="max-w-xl mx-auto py-8">
      <Card className="p-8 text-center">
        <Ticket size={38} className="mx-auto text-[#0071e3]" aria-hidden="true" />
        <h1 className="text-2xl font-semibold mt-4">Booking confirmed</h1>
        <p className="text-sm text-[#6E6E73] mt-2">Reception will assign your exact service and confirm your appointment time.</p>
        <p className="text-4xl font-bold tracking-tight text-[#0071e3] mt-6">{ticket.ticketNumber}</p>
        <p className="text-sm mt-3">{ticket.date} {ticket.time}</p>
        <p className="text-xs text-[#6E6E73] mt-4">A ticket notification will be sent to your email when delivery is configured.</p>
        <Button className="mt-6" onClick={() => setTicket(null)}>Book another appointment</Button>
      </Card>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div><h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><CalendarCheck size={21} aria-hidden="true" />Request an appointment</h1><p className="text-sm text-[#6E6E73]">Tell reception what you need. They will assign the exact service and confirm the time.</p></div>
      <Card className="p-6 space-y-4">
        <div className="rounded-2xl bg-black/[0.03] px-4 py-3 text-sm text-[#6E6E73]">Booking for <span className="font-medium text-[#1D1D1F]">{account.name}</span> at your selected branch. Your saved contact details will be used for notifications.</div>
        <Field label="Preferred date" htmlFor="customer-book-date"><Input id="customer-book-date" type="date" value={form.date} onChange={event => setForm(current => ({ ...current, date: event.target.value }))} min={new Date().toISOString().slice(0, 10)} /></Field>
        <Field label="Service needed (choose up to two)" htmlFor="customer-book-service"><div id="customer-book-service" className="grid grid-cols-2 gap-2">{serviceCategories.map(category => <button type="button" key={category} onClick={() => toggleCategory(category)} className={`rounded-xl border px-3 py-2.5 text-sm text-left ${form.serviceCategories.includes(category) ? 'border-[#0071e3] bg-[#0071e3]/10 text-[#0058b0]' : 'border-black/10 bg-white'}`}>{category}</button>)}</div></Field>
        <Field label="Preferred employee (optional)" htmlFor="customer-book-staff"><Select id="customer-book-staff" value={form.staffId} onChange={event => setForm(current => ({ ...current, staffId: event.target.value }))}><option value="">No preference</option>{availableStaff.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</Select></Field>
        <Button className="w-full" onClick={submit} disabled={saving}>{saving ? 'Sending request...' : 'Send booking request'}</Button>
      </Card>
    </div>
  );
}

export default CustomerBooking;
