import { useEffect, useState } from 'react';
import { CalendarCheck, UserRound, Scissors, AlertTriangle } from 'lucide-react';
import { AppointmentsApi, fmtKES } from '../lib/api';
import { Badge, Button, Card, EmptyState, LoadingState, toast } from '../components/ui';
import type { Appointment } from '../types';

function todayStr() { return new Date().toISOString().slice(0, 10); }

function EmployeeDashboard({ account, onAddService }: { account: { name?: string; staffId?: string }; onAddService: (appointment: Appointment) => void }) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    AppointmentsApi.list().then(items => {
      if (active) setAppointments(items.filter(item => item.staffId === account.staffId));
    }).catch(() => toast('Could not load your assigned clients.', 'error')).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [account.staffId]);

  if (loading) return <LoadingState label="Loading your assigned clients..." />;
  if (!account.staffId) return <EmptyState icon={AlertTriangle} title="Employee profile is not linked" description="Ask the salon owner to link your employee account before using the dashboard." />;

  const activeAppointments = appointments.filter(item => !['completed', 'cancelled', 'no-show'].includes(item.status));
  const todayAppointments = activeAppointments.filter(item => item.date === todayStr()).sort((a, b) => a.time.localeCompare(b.time));
  const otherAppointments = activeAppointments.filter(item => item.date !== todayStr()).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const assignedClients = Array.from(new Map(appointments.filter(item => item.customerId).map(item => [item.customerId, item])).values());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Client Dashboard</h1>
        <p className="text-sm text-[#6E6E73]">Welcome, {account.name || 'employee'}. Only clients assigned to you are shown.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-5"><CalendarCheck size={18} className="text-[#0071e3]" aria-hidden="true" /><p className="mt-3 text-xs text-[#6E6E73]">Today</p><p className="text-2xl font-semibold">{todayAppointments.length}</p></Card>
        <Card className="p-5"><UserRound size={18} className="text-[#0071e3]" aria-hidden="true" /><p className="mt-3 text-xs text-[#6E6E73]">Assigned clients</p><p className="text-2xl font-semibold">{assignedClients.length}</p></Card>
      </div>

      {activeAppointments.length === 0 ? <EmptyState icon={UserRound} title="No assigned clients" description="Clients assigned to you will appear here." /> : (
        <div className="space-y-4">
          {[['Today', todayAppointments], ['Upcoming', otherAppointments]].map(([label, items]) => {
            const listed = items as Appointment[];
            if (!listed.length) return null;
            return <section key={label as string} className="space-y-3"><h2 className="font-semibold">{label as string}</h2>{listed.map(appointment => (
              <Card key={appointment.id} className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3"><div className="rounded-xl bg-[#0071e3]/10 p-2 text-[#0071e3]"><Scissors size={18} aria-hidden="true" /></div><div><p className="font-medium">{appointment.customerName}</p><p className="text-sm text-[#6E6E73]">{appointment.serviceName} · {appointment.date} at {appointment.time}</p><p className="text-sm font-medium mt-1">{fmtKES(appointment.price)}</p></div></div>
                <div className="flex items-center gap-3"><Badge tone={appointment.status === 'in-service' ? 'warning' : 'info'}>{appointment.status.replace('-', ' ')}</Badge><Button size="sm" onClick={() => onAddService(appointment)}>Add service</Button></div>
              </Card>
            ))}</section>;
          })}
        </div>
      )}
    </div>
  );
}

export default EmployeeDashboard;
