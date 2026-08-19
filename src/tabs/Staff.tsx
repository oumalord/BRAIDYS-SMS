import { useEffect, useState } from 'react';
import { Plus, User, UserX, Star } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, LoadingState, toast } from '../components/ui';
import { BranchesApi, StaffApi, ReviewsApi } from '../lib/api';
import type { Branch, Role, Staff, Review } from '../types';

function StaffTab({ role = 'owner' }: { role?: Role }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = () => { StaffApi.list().then(setStaff).catch(() => toast('Could not load staff.', 'error')).finally(() => setLoading(false)); };
  useEffect(load, []);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [form, setForm] = useState({ name: '', role: 'Barber', chair: '', phone: '', accountEmail: '', password: '', branchId: '' });
  useEffect(() => { ReviewsApi.list().then(setReviews); BranchesApi.list().then(loaded => { setBranches(loaded); setForm(current => ({ ...current, branchId: current.branchId || window.localStorage.getItem('safigroom_selected_branch') || loaded[0]?.id || '' })); }); }, []);
  const avgRating = (staffId: string) => {
    const mine = reviews.filter(r => r.staffId === staffId);
    if (mine.length === 0) return null;
    return { avg: mine.reduce((s, r) => s + r.rating, 0) / mine.length, count: mine.length };
  };

  const addStaff = async () => {
    if (!form.name.trim()) { toast('Name is required.', 'error'); return; }
    if (form.accountEmail && form.password.length < 8) { toast('Employee password must be at least 8 characters.', 'error'); return; }
    if (!form.branchId) { toast('Choose a branch for this staff member.', 'error'); return; }
    await StaffApi.create({ ...form, accountStatus: form.accountEmail ? 'active' : 'pending', specialties: [], status: 'available' });
    toast(form.accountEmail ? 'Staff member and worker account created.' : 'Staff member added. Add an account email to activate worker access.', 'success');
    setOpen(false);
    setForm({ name: '', role: 'Barber', chair: '', phone: '', accountEmail: '', password: '', branchId: branches[0]?.id || '' });
    load();
  };

  const changeStatus = async (s: Staff, status: Staff['status']) => { await StaffApi.update(s.id, { status }); load(); };
  const changeEmployment = async (s: Staff) => {
    const laidOff = s.employmentStatus !== 'laid-off';
    await StaffApi.update(s.id, { employmentStatus: laidOff ? 'laid-off' : 'active', status: laidOff ? 'off' : 'available' });
    toast(laidOff ? `${s.name} has been marked laid off.` : `${s.name} has been reactivated.`, 'success');
    load();
  };

  const toneFor = (status: Staff['status']) => status === 'available' ? 'success' : status === 'in-service' ? 'warning' : status === 'break' ? 'info' : 'neutral';

  const STATUS_STYLES: Record<Staff['status'], string> = {
    available: 'bg-[#34C759]/10 text-[#1c7c34] border-[#34C759]/30',
    'in-service': 'bg-[#FF9500]/10 text-[#9a5c00] border-[#FF9500]/30',
    break: 'bg-[#0071e3]/10 text-[#0058b0] border-[#0071e3]/30',
    off: 'bg-black/10 text-[#6E6E73] border-black/10',
  };

  if (loading) return <LoadingState label="Loading staff…" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Staff & Chairs</h1><p className="text-sm text-[#6E6E73]">Manage your team and station availability.</p></div>
        <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />Add Staff</Button>
      </div>

      <div>
        <h2 className="font-semibold mb-3 text-sm text-[#6E6E73]">Chair / Station Board</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {staff.map(s => (
            <Card key={s.id} className="p-4 text-center">
              <p className="text-xs text-[#6E6E73] mb-1">{s.chair || 'Unassigned'}</p>
              <p className="font-medium text-sm">{s.name}</p>
              <div className="mt-2"><Badge tone={toneFor(s.status)}>{s.status.replace('-', ' ')}</Badge></div>
            </Card>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {staff.map(s => (
          <Card key={s.id} className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
            <div className="w-10 h-10 rounded-full bg-black/5 flex items-center justify-center flex-shrink-0"><User size={18} className="text-[#6E6E73]" aria-hidden="true" /></div>
            <div className="flex-1">
              <p className="font-medium">{s.name}</p>
              <p className="text-sm text-[#6E6E73]">{s.role} · {s.branchName || s.branch} · {s.chair} · 40% commission on completed service work</p>
              <p className="text-xs text-[#6E6E73]">Worker account: {s.accountEmail || 'Not created'}</p>
              {avgRating(s.id) && <p className="text-xs text-[#6E6E73] flex items-center gap-1 mt-0.5"><Star size={11} className="fill-[#FF9500] text-[#FF9500]" aria-hidden="true" />{avgRating(s.id)!.avg.toFixed(1)} ({avgRating(s.id)!.count} review{avgRating(s.id)!.count === 1 ? '' : 's'})</p>}
            </div>
            {role === 'owner' && <Button size="sm" variant={s.employmentStatus === 'laid-off' ? 'secondary' : 'danger'} onClick={() => changeEmployment(s)}><UserX size={14} aria-hidden="true" />{s.employmentStatus === 'laid-off' ? 'Reactivate' : 'Lay off'}</Button>}
            <select
              aria-label={`Status for ${s.name}`}
              value={s.status}
              disabled={s.employmentStatus === 'laid-off'}
              onChange={e => changeStatus(s, e.target.value as Staff['status'])}
              className={`rounded-full border text-xs font-semibold px-3 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] flex-shrink-0 ${STATUS_STYLES[s.status]}`}
              style={{ width: 'auto' }}
            >
              <option value="available">Available</option>
              <option value="in-service">In Service</option>
              <option value="break">On Break</option>
              <option value="off">Off Duty</option>
            </select>
          </Card>
        ))}
      </div>

      {open && (
        <Modal title="Add Staff Member" onClose={() => setOpen(false)} footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={addStaff}>Add Staff</Button>
        </>}>
          <div className="space-y-4">
            <Field label="Full name" htmlFor="s-name"><Input id="s-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Role" htmlFor="s-role">
              <Select id="s-role" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                <option>Barber</option><option>Hair Stylist</option><option>Nail Technician</option><option>Spa Therapist</option><option>Makeup Artist</option><option>Receptionist</option>
              </Select>
            </Field>
            <Field label="Chair / Station" htmlFor="s-chair"><Input id="s-chair" value={form.chair} onChange={e => setForm(f => ({ ...f, chair: e.target.value }))} placeholder="e.g. Chair 3" /></Field>
            <Field label="Branch" htmlFor="s-branch"><Select id="s-branch" value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</Select></Field>
            <Field label="Phone" htmlFor="s-phone"><Input id="s-phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+254…" /></Field>
            <Field label="Worker account email" htmlFor="s-account-email"><Input id="s-account-email" type="email" value={form.accountEmail} onChange={e => setForm(f => ({ ...f, accountEmail: e.target.value }))} placeholder="worker@example.com" /></Field>
            <Field label="Initial login password" htmlFor="s-account-password"><Input id="s-account-password" type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="At least 8 characters" /></Field>
            <p className="text-sm rounded-xl bg-[#0071e3]/10 text-[#0058b0] px-3 py-2">Compensation is fixed at 40% of completed service work.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default StaffTab;
