import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Plus, RefreshCw, Search, Send } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Field, Input, LoadingState, Modal, Select, Textarea, toast } from '../components/ui';
import { ComplaintsApi } from '../lib/api';
import type { Complaint, ComplaintStatus, Role } from '../types';

const STATUS_OPTIONS: { value: ComplaintStatus; label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }[] = [
  { value: 'open', label: 'Open', tone: 'warning' },
  { value: 'in_review', label: 'In review', tone: 'info' },
  { value: 'resolved', label: 'Resolved', tone: 'success' },
  { value: 'dismissed', label: 'Dismissed', tone: 'neutral' },
];

const emptyForm = { targetType: 'client' as 'client' | 'staff', targetName: '', category: 'Service concern', description: '', incidentDate: new Date().toISOString().slice(0, 10) };

function Complaints({ role }: { role: Role }) {
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, ComplaintStatus>>({});
  const canSubmit = ['owner', 'admin', 'manager', 'receptionist', 'barber'].includes(role);
  const canRespond = role === 'owner' || role === 'admin';

  const load = () => ComplaintsApi.list()
    .then(items => setComplaints(items))
    .catch((cause: any) => toast(cause?.message || 'Could not load complaints.', 'error'))
    .finally(() => setLoading(false));

  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => complaints.filter(item => {
    const matchesStatus = filter === 'all' || item.status === filter;
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [item.targetName, item.category, item.description, item.createdBy, item.branchId || ''].some(value => value.toLowerCase().includes(query));
    return matchesStatus && matchesSearch;
  }), [complaints, filter, search]);

  const counts = useMemo(() => ({
    open: complaints.filter(item => item.status === 'open').length,
    inReview: complaints.filter(item => item.status === 'in_review').length,
    resolved: complaints.filter(item => item.status === 'resolved').length,
  }), [complaints]);

  const submitComplaint = async () => {
    if (!form.targetName.trim() || !form.description.trim()) { toast('Person and complaint details are required.', 'error'); return; }
    setSaving(true);
    try {
      await ComplaintsApi.create({ ...form, targetName: form.targetName.trim(), description: form.description.trim() });
      setForm(emptyForm);
      setOpen(false);
      toast('Complaint submitted for review.', 'success');
      await load();
    } catch (cause: any) { toast(cause?.message || 'Could not submit complaint.', 'error'); }
    finally { setSaving(false); }
  };

  const saveReview = async (item: Complaint) => {
    const response = (responses[item.id] || '').trim();
    const status = statuses[item.id] || item.status;
    if (!response && status === item.status) return;
    setSaving(true);
    try {
      await ComplaintsApi.update(item.id, { status, ...(response ? { response } : {}) });
      setResponses(current => ({ ...current, [item.id]: '' }));
      toast('Complaint review saved.', 'success');
      await load();
    } catch (cause: any) { toast(cause?.message || 'Could not update complaint.', 'error'); }
    finally { setSaving(false); }
  };

  if (loading) return <LoadingState label="Loading complaints..." />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><MessageSquare size={20} aria-hidden="true" />Complaints</h1>
          <p className="text-sm text-[#6E6E73]">Staff concerns about clients or colleagues, with management follow-up.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => { setLoading(true); void load(); }}><RefreshCw size={15} aria-hidden="true" />Refresh</Button>
          {canSubmit && <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />New complaint</Button>}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-4"><p className="text-xs text-[#6E6E73]">Open</p><p className="mt-1 text-2xl font-semibold">{counts.open}</p></Card>
        <Card className="p-4"><p className="text-xs text-[#6E6E73]">In review</p><p className="mt-1 text-2xl font-semibold">{counts.inReview}</p></Card>
        <Card className="p-4"><p className="text-xs text-[#6E6E73]">Resolved</p><p className="mt-1 text-2xl font-semibold">{counts.resolved}</p></Card>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1"><Search size={15} className="absolute left-3 top-3 text-[#6E6E73]" aria-hidden="true" /><Input aria-label="Search complaints" placeholder="Search person, category, or details" value={search} onChange={event => setSearch(event.target.value)} className="pl-9" /></label>
        <Select aria-label="Filter complaints by status" value={filter} onChange={event => setFilter(event.target.value)} className="sm:w-44">
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
      </div>

      {visible.length === 0 ? (
        <Card><EmptyState icon={MessageSquare} title={complaints.length ? 'No matching complaints' : 'No complaints yet'} description={complaints.length ? 'Try another search or status filter.' : 'Submitted concerns will appear here for staff to review.'} /></Card>
      ) : (
        <div className="space-y-3">
          {visible.map(item => {
            const statusOption = STATUS_OPTIONS.find(option => option.value === item.status) || STATUS_OPTIONS[0];
            return <Card key={item.id} className="p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-2"><h2 className="font-semibold">{item.targetName}</h2><Badge tone="info">{item.targetType === 'client' ? 'Client' : 'Staff'}</Badge><Badge tone={statusOption.tone}>{statusOption.label}</Badge></div>
                  <p className="text-sm text-[#6E6E73]">{item.category} · Reported by {item.createdBy} · {new Date(item.createdAt).toLocaleString()}{item.incidentDate ? ` · Incident ${item.incidentDate}` : ''}</p>
                </div>
                {item.branchId && <span className="text-xs text-[#6E6E73]">Branch recorded</span>}
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm">{item.description}</p>

              {item.responses?.length > 0 && <div className="mt-4 space-y-2 border-l-2 border-[#17679a]/30 pl-3">
                {item.responses.map(response => <div key={response.id}><p className="text-xs font-medium">{response.authorName} <span className="font-normal text-[#6E6E73]">· {new Date(response.createdAt).toLocaleString()}</span></p><p className="mt-0.5 whitespace-pre-wrap text-sm text-[#4b5563]">{response.text}</p></div>)}
              </div>}

              {canRespond && <div className="mt-4 border-t border-black/5 pt-4">
                <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
                  <Field label="Review status" htmlFor={`complaint-status-${item.id}`}>
                    <Select id={`complaint-status-${item.id}`} value={statuses[item.id] || item.status} onChange={event => setStatuses(current => ({ ...current, [item.id]: event.target.value as ComplaintStatus }))}>
                      {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </Select>
                  </Field>
                  <Field label="Management response" htmlFor={`complaint-response-${item.id}`}>
                    <Textarea id={`complaint-response-${item.id}`} rows={2} maxLength={2000} value={responses[item.id] || ''} onChange={event => setResponses(current => ({ ...current, [item.id]: event.target.value }))} placeholder="Add a response or resolution note" />
                  </Field>
                </div>
                <div className="mt-2 flex justify-end"><Button size="sm" onClick={() => void saveReview(item)} disabled={saving || (!(responses[item.id] || '').trim() && (statuses[item.id] || item.status) === item.status)}><Send size={14} aria-hidden="true" />Save review</Button></div>
              </div>}
            </Card>;
          })}
        </div>
      )}

      {open && <Modal title="Submit a complaint" onClose={() => setOpen(false)} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => void submitComplaint()} disabled={saving || !form.targetName.trim() || !form.description.trim()}>{saving ? 'Submitting...' : 'Submit complaint'}</Button></>}>
        <div className="space-y-4 pb-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Concern about" htmlFor="complaint-target-type"><Select id="complaint-target-type" value={form.targetType} onChange={event => setForm(current => ({ ...current, targetType: event.target.value as 'client' | 'staff' }))}><option value="client">Client</option><option value="staff">Staff member</option></Select></Field>
            <Field label={form.targetType === 'client' ? 'Client name' : 'Staff member name'} htmlFor="complaint-target-name"><Input id="complaint-target-name" maxLength={120} value={form.targetName} onChange={event => setForm(current => ({ ...current, targetName: event.target.value }))} required /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" htmlFor="complaint-category"><Select id="complaint-category" value={form.category} onChange={event => setForm(current => ({ ...current, category: event.target.value }))}><option>Service concern</option><option>Conduct</option><option>Safety</option><option>Attendance</option><option>Property or payment</option><option>Other</option></Select></Field>
            <Field label="Incident date" htmlFor="complaint-date"><Input id="complaint-date" type="date" value={form.incidentDate} onChange={event => setForm(current => ({ ...current, incidentDate: event.target.value }))} /></Field>
          </div>
          <Field label="What happened?" htmlFor="complaint-description"><Textarea id="complaint-description" rows={5} maxLength={3000} value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} placeholder="Include relevant details for management review." required /></Field>
        </div>
      </Modal>}
    </div>
  );
}

export default Complaints;
