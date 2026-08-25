import { useEffect, useState } from 'react';
import { Plus, User, UserX, Star } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, LoadingState, toast } from '../components/ui';
import { BranchesApi, StaffApi, ReviewsApi } from '../lib/api';
import type { Branch, Role, Staff, Review } from '../types';

function StaffTab({ role = 'owner' }: { role?: Role }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [editForm, setEditForm] = useState({ name: '', phone: '', chair: '', password: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  const load = () => { StaffApi.list().then(setStaff).catch(() => toast('Could not load staff.', 'error')).finally(() => setLoading(false)); };
  useEffect(load, []);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [form, setForm] = useState({ name: '', role: 'Barber', chair: '', phone: '', credential: '', branchId: '' });
  useEffect(() => { ReviewsApi.list().then(setReviews); BranchesApi.list().then(loaded => { setBranches(loaded); setForm(current => ({ ...current, branchId: current.branchId || window.localStorage.getItem('safigroom_selected_branch') || loaded[0]?.id || '' })); }); }, []);
  const avgRating = (staffId: string) => {
    const mine = reviews.filter(r => r.staffId === staffId);
    if (mine.length === 0) return null;
    return { avg: mine.reduce((s, r) => s + r.rating, 0) / mine.length, count: mine.length };
  };

  const addStaff = async () => {
    if (!form.name.trim()) { toast('Name is required.', 'error'); return; }
    if (!form.phone.trim()) { toast('Phone number is required.', 'error'); return; }
    const isReceptionist = form.role === 'Receptionist';
    if (isReceptionist ? form.credential.length < 8 : !/^\d{4}$/.test(form.credential)) { toast(isReceptionist ? 'Receptionist password must be at least 8 characters.' : 'Staff PIN must be exactly 4 digits.', 'error'); return; }
    if (!form.branchId) { toast('Choose a branch for this staff member.', 'error'); return; }
    await StaffApi.create({ ...form, password: form.role === 'Receptionist' ? form.credential : undefined, pin: form.role === 'Receptionist' ? undefined : form.credential, accountStatus: 'active', specialties: [], status: 'available' });
    toast('Staff member and worker account created.', 'success');
    setOpen(false);
    setForm({ name: '', role: 'Barber', chair: '', phone: '', credential: '', branchId: branches[0]?.id || '' });
    load();
  };

  const changeStatus = async (s: Staff, status: Staff['status']) => { await StaffApi.update(s.id, { status }); load(); };
  const changeEmployment = async (s: Staff) => {
    const laidOff = s.employmentStatus !== 'laid-off';
    await StaffApi.update(s.id, { employmentStatus: laidOff ? 'laid-off' : 'active', status: laidOff ? 'off' : 'available' });
    toast(laidOff ? `${s.name} has been marked laid off.` : `${s.name} has been reactivated.`, 'success');
    load();
  };

  const editStaff = (member: Staff) => {
    setEditing(member);
    setEditForm({ name: member.name, phone: member.phone, chair: member.chair, password: '' });
  };

  const saveStaff = async () => {
    if (!editing || !editForm.name.trim() || !editForm.phone.trim()) { toast('Name and phone are required.', 'error'); return; }
    if (editForm.password && editForm.password.length < 8) { toast('Password must be at least 8 characters.', 'error'); return; }
    setSavingEdit(true);
    try {
      await StaffApi.update(editing.id, editForm);
      toast('Staff details and login account updated.', 'success');
      setEditing(null);
      load();
    } catch (cause: any) { toast(cause?.message || 'Could not update staff details.', 'error'); }
    finally { setSavingEdit(false); }
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
              <p className="text-sm text-[#6E6E73]">{s.role} · {s.branchName || s.branch} · {s.chair} · 50% commission after product and helper deductions</p>
              <p className="text-xs text-[#6E6E73]">Worker account: {s.phone || 'No phone number'}</p>
              {avgRating(s.id) && <p className="text-xs text-[#6E6E73] flex items-center gap-1 mt-0.5"><Star size={11} className="fill-[#FF9500] text-[#FF9500]" aria-hidden="true" />{avgRating(s.id)!.avg.toFixed(1)} ({avgRating(s.id)!.count} review{avgRating(s.id)!.count === 1 ? '' : 's'})</p>}
            </div>
            {(role === 'owner' || role === 'admin') && <Button size="sm" variant={s.employmentStatus === 'laid-off' ? 'secondary' : 'danger'} onClick={() => changeEmployment(s)}><UserX size={14} aria-hidden="true" />{s.employmentStatus === 'laid-off' ? 'Reactivate' : 'Lay off'}</Button>}
            {(role === 'owner' || role === 'admin') && <Button size="sm" variant="secondary" onClick={() => editStaff(s)}>Edit details</Button>}
            {(role === 'owner' || role === 'admin') && <select
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
            </select>}
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
            <Field label={form.role === 'Receptionist' ? 'Login password' : 'Login PIN'} htmlFor="s-account-credential"><Input id="s-account-credential" type="password" inputMode={form.role === 'Receptionist' ? 'text' : 'numeric'} maxLength={form.role === 'Receptionist' ? 128 : 4} minLength={form.role === 'Receptionist' ? 8 : 4} value={form.credential} onChange={e => setForm(f => ({ ...f, credential: form.role === 'Receptionist' ? e.target.value : e.target.value.replace(/\D/g, '').slice(0, 4) }))} placeholder={form.role === 'Receptionist' ? 'At least 8 characters' : 'Exactly 4 digits'} /></Field>
            <p className="text-sm rounded-xl bg-[#0071e3]/10 text-[#0058b0] px-3 py-2">Commission is fixed at 50% after product and helper deductions.</p>
          </div>
        </Modal>
      )}

      {editing && <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)} footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={saveStaff} disabled={savingEdit}>{savingEdit ? 'Saving...' : 'Save changes'}</Button></>}>
        <form className="space-y-4" autoComplete="off" onSubmit={event => { event.preventDefault(); void saveStaff(); }}>
          <Field label="Full name" htmlFor="edit-s-name"><Input id="edit-s-name" name="staff-display-name" autoComplete="off" value={editForm.name} onChange={e => setEditForm(current => ({ ...current, name: e.target.value }))} /></Field>
          <Field label="Phone" htmlFor="edit-s-phone"><Input id="edit-s-phone" name="staff-phone-number" autoComplete="off" value={editForm.phone} onChange={e => setEditForm(current => ({ ...current, phone: e.target.value }))} /></Field>
          <Field label="Chair / Station" htmlFor="edit-s-chair"><Input id="edit-s-chair" name="staff-chair" autoComplete="off" value={editForm.chair} onChange={e => setEditForm(current => ({ ...current, chair: e.target.value }))} /></Field>
          <Field label="New login password (optional)" htmlFor="edit-s-password"><Input id="edit-s-password" name="staff-new-password" autoComplete="new-password" type="password" minLength={8} value={editForm.password} onChange={e => setEditForm(current => ({ ...current, password: e.target.value }))} placeholder="Leave blank to keep current password" /></Field>
        </form>
      </Modal>}
    </div>
  );
}

export default StaffTab;
