import { useEffect, useState } from 'react';
import { CalendarDays, Check, Clock3, Fingerprint, LogIn, LogOut, MapPin, RefreshCw } from 'lucide-react';
import { AttendanceApi, StaffApi } from '../lib/api';
import { Badge, Button, Card, Field, Input, LoadingState, Modal, toast } from '../components/ui';
import type { AttendanceClientAssignment, AttendanceRecord, Role, Staff } from '../types';

interface AttendanceRow {
  key: string;
  name: string;
  role: string;
  branchName: string;
  checkInAt: number | null;
  checkOutAt: number | null;
}

function nairobiDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find(part => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function formatTime(timestamp?: number | null) {
  return timestamp ? new Intl.DateTimeFormat('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' }).format(timestamp) : '—';
}

function currentPosition(): Promise<{ latitude: number; longitude: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This device does not provide location access.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
      cause => reject(new Error(cause.code === cause.PERMISSION_DENIED ? 'Allow location access to record attendance.' : cause.code === cause.TIMEOUT ? 'Could not get your location. Try again.' : 'Location is unavailable. Try again outdoors.')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  });
}

function Attendance({ role }: { role: Role }) {
  const canViewDaily = ['owner', 'admin', 'receptionist'].includes(role);
  const [date, setDate] = useState(nairobiDate);
  const [mine, setMine] = useState<AttendanceRecord | null>(null);
  const [clients, setClients] = useState<AttendanceClientAssignment[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const dailyRequest = canViewDaily
      ? Promise.all([AttendanceApi.list(date), StaffApi.list()])
      : Promise.resolve([[], []] as [AttendanceRecord[], Staff[]]);
    Promise.all([AttendanceApi.mine(), dailyRequest])
      .then(([today, [daily, roster]]) => {
        if (!active) return;
        setMine(today.item);
        setClients(today.clients);
        setRecords(daily);
        setStaff(roster);
      })
      .catch(cause => { if (active) toast(cause?.message || 'Could not load attendance.', 'error'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [canViewDaily, date]);

  const refresh = async () => {
    const dailyRequest = canViewDaily
      ? Promise.all([AttendanceApi.list(date), StaffApi.list()])
      : Promise.resolve([[], []] as [AttendanceRecord[], Staff[]]);
    const [today, [daily, roster]] = await Promise.all([AttendanceApi.mine(), dailyRequest]);
    setMine(today.item);
    setClients(today.clients);
    setRecords(daily);
    setStaff(roster);
  };

  useEffect(() => {
    if (!mine?.checkInAt || mine.checkOutAt) return;
    const refreshClients = () => AttendanceApi.mine().then(today => {
      setMine(today.item);
      setClients(today.clients);
    }).catch(() => {});
    const intervalId = window.setInterval(refreshClients, 15000);
    return () => window.clearInterval(intervalId);
  }, [mine?.checkInAt, mine?.checkOutAt]);

  const punch = async (action: 'check-in' | 'check-out') => {
    setSaving(true);
    try {
      const location = await currentPosition();
      const item = action === 'check-in' ? await AttendanceApi.checkIn(location) : await AttendanceApi.checkOut(location);
      setMine(item);
      await refresh();
      setDialogOpen(false);
      toast(action === 'check-in' ? 'Check-in recorded.' : 'Check-out recorded.', 'success');
    } catch (cause: any) {
      toast(cause?.message || 'Could not record attendance.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const checkedIn = Boolean(mine?.checkInAt);
  const checkedOut = Boolean(mine?.checkOutAt);
  let account: { branchId?: string } | null = null;
  try { account = JSON.parse(window.localStorage.getItem('safigroom_account') || 'null'); } catch { account = null; }
  const activeBranchId = window.localStorage.getItem('safigroom_selected_branch') || account?.branchId || '';
  const visibleStaff = staff.filter(member => member.employmentStatus !== 'laid-off' && (!activeBranchId || !member.branchId || member.branchId === activeBranchId));
  const attendanceByStaffId = new Map(records.filter(record => record.staffId).map(record => [String(record.staffId), record]));
  const representedStaffIds = new Set(visibleStaff.map(member => String(member.id)));
  const attendanceRows: AttendanceRow[] = visibleStaff.map(member => {
    const record = attendanceByStaffId.get(String(member.id));
    return { key: `staff:${member.id}`, name: member.name, role: member.role, branchName: member.branchName || member.branch || '', checkInAt: record?.checkInAt || null, checkOutAt: record?.checkOutAt || null };
  });
  records.filter(record => !record.staffId || !representedStaffIds.has(String(record.staffId))).forEach(record => {
    attendanceRows.push({ key: record.id, name: record.name, role: record.role, branchName: record.branchName || '', checkInAt: record.checkInAt || null, checkOutAt: record.checkOutAt || null });
  });
  attendanceRows.sort((first, second) => Number(first.checkInAt || Number.MAX_SAFE_INTEGER) - Number(second.checkInAt || Number.MAX_SAFE_INTEGER) || first.name.localeCompare(second.name));
  const presentCount = attendanceRows.filter(row => row.checkInAt).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Attendance</h1><p className="text-sm text-[#6E6E73]">Daily staff check-in and check-out</p></div>
        <Button variant="secondary" onClick={() => { setLoading(true); void refresh().catch(cause => toast(cause?.message || 'Could not refresh attendance.', 'error')).finally(() => setLoading(false)); }} disabled={loading}><RefreshCw size={15} aria-hidden="true" />Refresh</Button>
      </div>

      <Card className="overflow-hidden">
        <div className="grid gap-6 p-5 sm:grid-cols-[1fr_auto] sm:items-center sm:p-7">
          <div>
            <p className="text-sm font-medium text-[#6E6E73]">Today · {mine?.date || nairobiDate()}</p>
            <h2 className="mt-1 text-xl font-semibold">{checkedOut ? 'Shift complete' : checkedIn ? `Checked in at ${formatTime(mine?.checkInAt)}` : 'Ready to check in'}</h2>
            <p className="mt-2 flex items-center gap-1.5 text-sm text-[#6E6E73]"><MapPin size={15} aria-hidden="true" />Braidy Saloon, Lumumba Drive · within 500 m</p>
            {checkedOut && <p className="mt-1 text-sm text-[#6E6E73]">Checked out at {formatTime(mine?.checkOutAt)}</p>}
          </div>
          <button type="button" onClick={() => setDialogOpen(true)} aria-label="Open check in or check out" className="mx-auto flex h-28 w-28 items-center justify-center rounded-full bg-[#17679a] text-white shadow-[0_0_0_12px_rgba(23,103,154,0.12),0_0_0_24px_rgba(23,103,154,0.07)] transition hover:bg-[#12547f] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#0071e3]/40 disabled:opacity-50 sm:mx-4" disabled={loading}>
            <Fingerprint size={54} strokeWidth={1.7} aria-hidden="true" />
          </button>
        </div>
      </Card>

      {checkedIn && !checkedOut && <section className="space-y-3">
        <div className="flex items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">Clients assigned today</h2><p className="text-sm text-[#6E6E73]">{clients.length} client{clients.length === 1 ? '' : 's'} · ticks reset at check-out</p></div></div>
        {clients.length === 0 ? <Card className="p-4 text-sm text-[#6E6E73]">No clients have been assigned to you today yet.</Card> : <div className="divide-y divide-black/5 rounded-xl border border-black/10 bg-white">{clients.map(client => <div key={client.id} className="flex items-center gap-3 px-4 py-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#34C759]/10 text-[#1c7c34]"><Check size={16} strokeWidth={2.5} aria-label="Assigned" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{client.customerName}</p><p className="truncate text-xs text-[#6E6E73]">{client.serviceName}</p></div><span className="shrink-0 text-xs text-[#6E6E73]">{client.time || '—'}</span></div>)}</div>}
      </section>}

      {canViewDaily && <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><h2 className="text-lg font-semibold">Daily attendance</h2><p className="text-sm text-[#6E6E73]">{presentCount} checked in · {attendanceRows.length - presentCount} not checked in · Nairobi time</p></div>
          <Field label="Attendance date" htmlFor="attendance-date"><Input id="attendance-date" type="date" value={date} onChange={event => setDate(event.target.value)} /></Field>
        </div>
        {loading ? <LoadingState label="Loading attendance…" /> : attendanceRows.length === 0 ? <Card className="p-6 text-sm text-[#6E6E73]">No active staff found for this branch.</Card> : <div className="overflow-x-auto rounded-xl border border-black/10 bg-white">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="border-b border-black/5 text-xs text-[#6E6E73]"><tr><th className="px-4 py-3 font-medium">Staff member</th><th className="px-4 py-3 font-medium">Role</th><th className="px-4 py-3 font-medium">Branch</th><th className="px-4 py-3 font-medium">Status</th><th className="px-4 py-3 font-medium">Check in</th><th className="px-4 py-3 font-medium">Check out</th></tr></thead>
            <tbody>{attendanceRows.map(row => <tr key={row.key} className="border-b border-black/5 last:border-0"><td className="px-4 py-3 font-medium">{row.name}</td><td className="px-4 py-3 capitalize">{row.role}</td><td className="px-4 py-3">{row.branchName || '—'}</td><td className="px-4 py-3"><Badge tone={row.checkOutAt ? 'success' : row.checkInAt ? 'info' : 'warning'}>{row.checkOutAt ? 'Complete' : row.checkInAt ? 'On shift' : 'Not checked in'}</Badge></td><td className="px-4 py-3"><span className="inline-flex items-center gap-1.5"><LogIn size={14} aria-hidden="true" />{formatTime(row.checkInAt)}</span></td><td className="px-4 py-3"><span className="inline-flex items-center gap-1.5"><LogOut size={14} aria-hidden="true" />{formatTime(row.checkOutAt)}</span></td></tr>)}</tbody>
          </table>
        </div>}
      </section>}

      {dialogOpen && <Modal title="Check In / Check Out" onClose={() => { if (!saving) setDialogOpen(false); }}>
        <div className="space-y-4 pb-5">
          <p className="text-sm text-[#6E6E73]">Your device location must be within 500 meters of Braidy Saloon. Location is checked when you submit.</p>
          <div className="grid grid-cols-2 gap-3">
            <Button onClick={() => void punch('check-in')} disabled={saving || checkedIn} className="min-h-14"><LogIn size={17} aria-hidden="true" />{saving ? 'Checking…' : 'Check In'}</Button>
            <Button variant="secondary" onClick={() => void punch('check-out')} disabled={saving || !checkedIn || checkedOut} className="min-h-14"><LogOut size={17} aria-hidden="true" />Check Out</Button>
          </div>
          {checkedIn && <p className="flex items-center gap-1.5 text-xs text-[#6E6E73]"><Clock3 size={14} aria-hidden="true" />Checked in at {formatTime(mine?.checkInAt)}{checkedOut ? ` · checked out at ${formatTime(mine?.checkOutAt)}` : ''}</p>}
          <p className="flex items-center gap-1.5 text-xs text-[#6E6E73]"><CalendarDays size={14} aria-hidden="true" />One check-in and one check-out per Nairobi day.</p>
        </div>
      </Modal>}
    </div>
  );
}

export default Attendance;