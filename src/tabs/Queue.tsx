import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { UserPlus, Users } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, EmptyState, LoadingState, toast } from '../components/ui';
import { AuthApi, QueueApi, StaffApi } from '../lib/api';
import type { QueueEntry, Staff } from '../types';

interface ColumnProps { title: string; tone: 'neutral' | 'warning' | 'success'; count: number; children: ReactNode; }
function Column({ title, tone, count, children }: ColumnProps) {
  return (
    <Card className="p-4 flex-1 min-w-[260px]">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm">{title}</h2>
        <Badge tone={tone}>{count}</Badge>
      </div>
      <div className="space-y-2">{children}</div>
    </Card>
  );
}

function Queue() {
  const [items, setItems] = useState<QueueEntry[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ customerName: '', serviceName: '', staffId: '' });

  const load = () => { QueueApi.list().then(setItems).catch(() => {}).finally(() => setLoading(false)); };
  useEffect(() => {
    StaffApi.list().then(setStaff);
    load();
    const id = setInterval(load, 6000);
    return () => clearInterval(id);
  }, []);

  const join = async () => {
    if (!form.customerName.trim()) { toast('Customer name is required.', 'error'); return; }
    const staffMember = staff.find(s => s.id === form.staffId);
    await QueueApi.join({ customerName: form.customerName, serviceName: form.serviceName, staffId: staffMember?.id || null, staffName: staffMember?.name || null });
    toast('Added to queue.', 'success');
    setOpen(false);
    setForm({ customerName: '', serviceName: '', staffId: '' });
    load();
  };

  const callNext = async (id: string) => { await QueueApi.update(id, { status: 'in-service' }); load(); };
  const complete = async (id: string) => { await QueueApi.update(id, { status: 'completed' }); load(); };

  const waiting = items.filter(i => i.status === 'waiting').sort((a, b) => a.position - b.position);
  const inService = items.filter(i => i.status === 'in-service');
  const completed = items.filter(i => i.status === 'completed').slice(-5);
  const account = AuthApi.account();
  const canManageAll = ['owner', 'manager', 'receptionist'].includes(account?.role);

  if (loading) return <LoadingState label="Loading queue…" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Digital Queue</h1>
          <p className="text-sm text-[#6E6E73]">Live walk-in queue, refreshing automatically.</p>
        </div>
        <Button onClick={() => setOpen(true)}><UserPlus size={16} aria-hidden="true" />Join Queue</Button>
      </div>

      {items.length === 0 ? <EmptyState icon={Users} title="Queue is empty" description="No one is currently waiting." action={<Button onClick={() => setOpen(true)}>Add a walk-in</Button>} /> : (
        <div className="flex flex-col md:flex-row gap-4">
          <Column title="Waiting" tone="neutral" count={waiting.length}>
            {waiting.length === 0 && <p className="text-xs text-[#6E6E73]">No one waiting.</p>}
            {waiting.map((q, i) => (
              <div key={q.id} className="rounded-2xl border border-black/5 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-[#6E6E73]">#{i + 1}</span>
                  <Badge tone="neutral">Waiting</Badge>
                </div>
                <p className="font-medium text-sm mt-1">{q.customerName}</p>
                {q.ticketNumber && <p className="text-xs font-semibold text-[#0071e3] mt-1">Ticket {q.ticketNumber}</p>}
                <p className="text-xs text-[#6E6E73]">{q.serviceName || 'No service specified'}{q.staffName ? ` · ${q.staffName}` : ''}</p>
                {(canManageAll || q.staffId === account?.staffId) && <div className="flex gap-2 mt-2"><Button size="sm" onClick={() => callNext(q.id)}>Call Next</Button></div>}
              </div>
            ))}
          </Column>
          <Column title="In Service" tone="warning" count={inService.length}>
            {inService.length === 0 && <p className="text-xs text-[#6E6E73]">No one in service.</p>}
            {inService.map(q => (
              <div key={q.id} className="rounded-2xl border border-black/5 p-3">
                <p className="font-medium text-sm">{q.customerName}</p>
                {q.ticketNumber && <p className="text-xs font-semibold text-[#0071e3] mt-1">Ticket {q.ticketNumber}</p>}
                <p className="text-xs text-[#6E6E73]">{q.serviceName || 'No service specified'}{q.staffName ? ` · ${q.staffName}` : ''}</p>
                {(canManageAll || q.staffId === account?.staffId) && <Button size="sm" className="mt-2" onClick={() => complete(q.id)}>Mark Served</Button>}
              </div>
            ))}
          </Column>
          <Column title="Completed Today" tone="success" count={completed.length}>
            {completed.length === 0 && <p className="text-xs text-[#6E6E73]">No completed visits yet.</p>}
            {completed.map(q => (
              <div key={q.id} className="rounded-2xl border border-black/5 p-3 opacity-70">
                <p className="font-medium text-sm">{q.customerName}</p>
                {q.ticketNumber && <p className="text-xs text-[#6E6E73]">Ticket {q.ticketNumber}</p>}
                <p className="text-xs text-[#6E6E73]">{q.serviceName}</p>
              </div>
            ))}
          </Column>
        </div>
      )}

      {open && (
        <Modal title="Join the Queue" onClose={() => setOpen(false)} footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={join}>Add to Queue</Button>
        </>}>
          <div className="space-y-4">
            <Field label="Customer name" htmlFor="q-name"><Input id="q-name" value={form.customerName} onChange={e => setForm(f => ({ ...f, customerName: e.target.value }))} /></Field>
            <Field label="Service (optional)" htmlFor="q-service"><Input id="q-service" value={form.serviceName} onChange={e => setForm(f => ({ ...f, serviceName: e.target.value }))} placeholder="e.g. Beard Trim & Shape" /></Field>
            <Field label="Preferred staff (optional)" htmlFor="q-staff">
              <Select id="q-staff" value={form.staffId} onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))}>
                <option value="">No preference</option>
                {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Queue;
