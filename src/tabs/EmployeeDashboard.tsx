import { useEffect, useState } from 'react';
import { CalendarCheck, UserRound, Scissors, AlertTriangle, DollarSign, Clock } from 'lucide-react';
import { AppointmentsApi, StaffApi, fmtKES } from '../lib/api';
import { Badge, Button, Card, EmptyState, LoadingState, toast } from '../components/ui';
import type { Appointment } from '../types';

function todayStr() { return new Date().toISOString().slice(0, 10); }

function EmployeeDashboard({ account, onAddService }: { account: { name?: string; staffId?: string }; onAddService: (appointment: Appointment) => void }) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [dailyEarnings, setDailyEarnings] = useState(0);
  const [fortnightEarnings, setFortnightEarnings] = useState(0);
  const [dailyCommission, setDailyCommission] = useState(0);
  const [dailyAssistant, setDailyAssistant] = useState(0);
  const [completedWork, setCompletedWork] = useState<{ serviceName: string; createdAt: number; role: 'commission' | 'assistant'; amount: number }[]>([]);
  const [waitingClients, setWaitingClients] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    Promise.all([AppointmentsApi.list(), StaffApi.myEarnings()]).then(([items, earnings]) => {
      if (!active) return;
      const staffAppointments = items.filter(item => item.staffId === account.staffId);
      setAppointments(staffAppointments);
      setDailyEarnings(earnings.today.total || 0);
      setFortnightEarnings(earnings.fortnight.total || 0);
      setDailyCommission(earnings.today.commission || 0);
      setDailyAssistant(earnings.today.assistant || 0);
      setCompletedWork(earnings.completedWork || []);
      
      // Show waiting clients (those checked-in and waiting)
      const waiting = staffAppointments.filter(item => item.date === todayStr() && ['checked-in', 'pending'].includes(item.status));
      setWaitingClients(waiting);
    }).catch(() => toast('Could not load your assigned clients.', 'error')).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [account.staffId]);

  if (loading) return <LoadingState label="Loading your assigned clients..." />;
  if (!account.staffId) return <EmptyState icon={AlertTriangle} title="Employee profile is not linked" description="Ask the salon owner to link your employee account before using the dashboard." />;

  const sortedAppointments = [...appointments].sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  const assignedClients = Array.from(new Map(appointments.filter(item => item.customerId).map(item => [item.customerId, item])).values());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Client Dashboard</h1>
        <p className="text-sm text-[#6E6E73]">Welcome, {account.name || 'employee'}. Only clients assigned to you are shown.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5"><Clock size={18} className="text-[#0071e3]" aria-hidden="true" /><p className="mt-3 text-xs text-[#6E6E73]">Waiting Now</p><p className="text-2xl font-semibold">{waitingClients.length}</p></Card>
        <Card className="p-5"><DollarSign size={18} className="text-green-600" aria-hidden="true" /><p className="mt-3 text-xs text-[#6E6E73]">Today's Earnings</p><p className="text-2xl font-semibold">{fmtKES(dailyEarnings)}</p><p className="text-xs text-[#6E6E73] mt-1">Commission {fmtKES(dailyCommission)} + assistant compensation {fmtKES(dailyAssistant)}</p></Card>
        <Card className="p-5"><UserRound size={18} className="text-[#0071e3]" aria-hidden="true" /><p className="mt-3 text-xs text-[#6E6E73]">Assigned clients</p><p className="text-2xl font-semibold">{assignedClients.length}</p></Card>
      </div>

      <Card className="p-5">
        <p className="text-xs text-[#6E6E73]">My 14-day Earnings</p>
        <p className="text-xl font-semibold mt-1">{fmtKES(fortnightEarnings)}</p>
      </Card>

      <Card className="p-5">
        <h2 className="font-semibold mb-3">Completed Services</h2>
        {completedWork.length === 0 ? <p className="text-sm text-[#6E6E73]">Completed services and their earnings will appear here.</p> : <div className="space-y-2">{completedWork.map((work, index) => <div key={`${work.createdAt}-${work.serviceName}-${index}`} className="flex items-center justify-between gap-3 border-b border-black/5 pb-2 last:border-0"><div><p className="text-sm font-medium">{work.serviceName}</p><p className="text-xs text-[#6E6E73]">{new Date(work.createdAt).toLocaleString()} · {work.role === 'assistant' ? 'Assistant fee' : 'Commission'}</p></div><p className="shrink-0 text-sm font-semibold">{fmtKES(work.amount)}</p></div>)}</div>}
      </Card>

      {waitingClients.length > 0 && (
        <Card className="p-5 border-l-4 border-l-orange-500 bg-orange-50/50">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Clock size={16} className="text-orange-600" aria-hidden="true" />Clients Waiting for You</h2>
          <div className="space-y-2">{waitingClients.map(client => (
            <div key={client.id} className="flex items-center justify-between rounded-lg bg-white p-3 text-sm">
              <div><p className="font-medium">{client.customerName}</p><p className="text-xs text-[#6E6E73]">{client.serviceName}</p></div>
              <Button size="sm" onClick={() => onAddService(client)}>Start</Button>
            </div>
          ))}</div>
        </Card>
      )}

      {sortedAppointments.length === 0 ? <EmptyState icon={UserRound} title="No assigned clients" description="Clients assigned to you will appear here." /> : (
        <div className="space-y-4">
          <section className="space-y-3"><h2 className="font-semibold">My appointments</h2>{sortedAppointments.map(appointment => (
              <Card key={appointment.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3"><div className="rounded-xl bg-[#0071e3]/10 p-2 text-[#0071e3]"><Scissors size={18} aria-hidden="true" /></div><div><p className="font-medium">{appointment.customerName}</p><p className="text-sm text-[#6E6E73]">{appointment.serviceName} · {appointment.date} at {appointment.time}</p><p className="text-sm font-medium mt-1">{fmtKES(appointment.price)}</p></div></div>
                <div className="flex items-center gap-3"><Badge tone={appointment.status === 'in-service' ? 'warning' : 'info'}>{appointment.status.replace('-', ' ')}</Badge><Button size="sm" onClick={() => onAddService(appointment)}>Add service</Button></div>
              </Card>
            ))}</section>
        </div>
      )}
    </div>
  );
}

export default EmployeeDashboard;
