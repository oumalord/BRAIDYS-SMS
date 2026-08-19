import { useEffect, useState } from 'react';
import { CalendarCheck, Ticket } from 'lucide-react';
import { AppointmentsApi, AuthApi, CustomersApi, PublicApi, ServicesApi, StaffApi, fmtMoney } from '../lib/api';
import { MpesaPayModal } from '../components/MpesaPay';
import { Card, Button, Field, Input, Select, toast } from '../components/ui';
import type { Branch, Customer, ServiceItem, Staff } from '../types';

function CustomerBooking() {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [form, setForm] = useState({ name: '', phone: '', email: '', branchId: '', serviceId: '', date: new Date().toISOString().slice(0, 10), time: '10:00', staffId: '' });
  const [showPay, setShowPay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ticket, setTicket] = useState<{ ticketNumber: string; date: string; time: string } | null>(null);

  useEffect(() => {
    const account = AuthApi.account();
    Promise.all([ServicesApi.list(), StaffApi.list(), CustomersApi.list(), PublicApi.branches(account?.salonId || '')]).then(([loadedServices, loadedStaff, loadedCustomers, loadedBranches]) => {
      setServices(loadedServices);
      setStaff(loadedStaff);
      setCustomers(loadedCustomers);
      setBranches(loadedBranches);
      setForm(current => ({ ...current, branchId: current.branchId || account?.branchId || loadedBranches[0]?.id || '' }));
    }).catch(() => toast('Could not load booking options.', 'error'));
  }, []);

  const selectedService = services.find(service => service.id === form.serviceId);
  const availableStaff = staff.filter(member => member.status === 'available' && (!form.branchId || member.branchId === form.branchId));

  const book = async (mpesaReceiptNumber?: string) => {
    if (!selectedService || !form.name.trim() || !form.phone.trim() || !form.email.trim() || !form.branchId) {
      toast('Name, phone, email, branch and service are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      const existing = customers.find(customer => customer.phone.replace(/\s/g, '') === form.phone.replace(/\s/g, ''));
      const customer = existing || (await CustomersApi.create({ name: form.name, phone: form.phone, email: form.email, notes: '' })).data;
      const assigned = staff.find(member => member.id === form.staffId);
      const { data } = await AppointmentsApi.create({
        customerId: customer.id,
        customerName: form.name,
        customerEmail: form.email,
        branchId: form.branchId,
        serviceId: selectedService.id,
        serviceName: selectedService.name,
        price: selectedService.price,
        currency: selectedService.currency,
        durationMin: selectedService.durationMin,
        staffId: assigned?.id || null,
        staffName: assigned?.name || null,
        date: form.date,
        time: form.time,
        mpesaReceiptNumber,
      });
      setTicket({ ticketNumber: data.ticketNumber, date: form.date, time: form.time });
      setShowPay(false);
      toast(mpesaReceiptNumber ? 'Payment received and appointment booked.' : 'Appointment booked.', 'success');
    } catch (cause: any) {
      toast(cause?.message || 'Could not complete the booking.', 'error');
      setShowPay(false);
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    if (!selectedService) { toast('Choose a service first.', 'error'); return; }
    if (selectedService.currency === 'KES' && selectedService.price > 0) setShowPay(true);
    else void book();
  };

  if (ticket) return (
    <div className="max-w-xl mx-auto py-8">
      <Card className="p-8 text-center">
        <Ticket size={38} className="mx-auto text-[#0071e3]" aria-hidden="true" />
        <h1 className="text-2xl font-semibold mt-4">Booking confirmed</h1>
        <p className="text-sm text-[#6E6E73] mt-2">Your ticket has been added to the salon queue.</p>
        <p className="text-4xl font-bold tracking-tight text-[#0071e3] mt-6">{ticket.ticketNumber}</p>
        <p className="text-sm mt-3">{ticket.date} at {ticket.time}</p>
        <p className="text-xs text-[#6E6E73] mt-4">A ticket notification will be sent to your email when delivery is configured.</p>
        <Button className="mt-6" onClick={() => setTicket(null)}>Book another appointment</Button>
      </Card>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div><h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><CalendarCheck size={21} aria-hidden="true" />Book an appointment</h1><p className="text-sm text-[#6E6E73]">Choose your service and time. The salon will assign an available employee if you have no preference.</p></div>
      <Card className="p-6 space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Full name" htmlFor="customer-book-name"><Input id="customer-book-name" value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></Field>
          <Field label="Phone" htmlFor="customer-book-phone"><Input id="customer-book-phone" value={form.phone} onChange={event => setForm(current => ({ ...current, phone: event.target.value }))} placeholder="0712345678" /></Field>
        </div>
        <Field label="Email for ticket notifications" htmlFor="customer-book-email"><Input id="customer-book-email" type="email" value={form.email} onChange={event => setForm(current => ({ ...current, email: event.target.value }))} placeholder="you@example.com" /></Field>
        <Field label="Branch" htmlFor="customer-book-branch"><Select id="customer-book-branch" value={form.branchId} onChange={event => setForm(current => ({ ...current, branchId: event.target.value, staffId: '' }))}><option value="">Choose a branch</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</Select></Field>
        <Field label="Service" htmlFor="customer-book-service"><Select id="customer-book-service" value={form.serviceId} onChange={event => setForm(current => ({ ...current, serviceId: event.target.value }))}><option value="">Choose a service</option>{services.map(service => <option key={service.id} value={service.id}>{service.name} - {fmtMoney(service.price, service.currency)} - {service.durationMin} min</option>)}</Select></Field>
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Date" htmlFor="customer-book-date"><Input id="customer-book-date" type="date" value={form.date} min={new Date().toISOString().slice(0, 10)} onChange={event => setForm(current => ({ ...current, date: event.target.value }))} /></Field>
          <Field label="Time" htmlFor="customer-book-time"><Input id="customer-book-time" type="time" value={form.time} onChange={event => setForm(current => ({ ...current, time: event.target.value }))} /></Field>
          <Field label="Preferred employee" htmlFor="customer-book-staff"><Select id="customer-book-staff" value={form.staffId} onChange={event => setForm(current => ({ ...current, staffId: event.target.value }))}><option value="">No preference</option>{availableStaff.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</Select></Field>
        </div>
        <Button className="w-full" onClick={submit} disabled={saving}>{saving ? 'Booking...' : selectedService?.currency === 'KES' ? 'Pay now and book' : 'Book appointment'}</Button>
      </Card>
      {showPay && selectedService && <MpesaPayModal amountKES={selectedService.price} purpose="customer_booking" initialPhone={form.phone} onClose={() => setShowPay(false)} onSuccess={receipt => void book(receipt)} />}
    </div>
  );
}

export default CustomerBooking;
