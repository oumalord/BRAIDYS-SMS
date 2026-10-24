import { useEffect, useMemo, useState } from 'react';
import { Activity, CalendarDays, Clock3, Download, MessageSquare, RefreshCw, Search, Scissors, Star, Users } from 'lucide-react';
import { Badge, Button, Card, Input, LoadingState, Select, StatCard } from '../components/ui';
import { downloadCSV, fmtMoney, StaffPerformanceApi } from '../lib/api';
import type { StaffPerformanceReport } from '../types';

type SortKey = 'revenue' | 'completed' | 'earnings' | 'hours' | 'rating' | 'name';

function formatDate(date: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) {
  return new Intl.DateTimeFormat('en-KE', { timeZone: 'Africa/Nairobi', ...options }).format(new Date(`${date}T12:00:00+03:00`));
}

function formatTime(timestamp: number | null) {
  return timestamp ? new Intl.DateTimeFormat('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' }).format(timestamp) : '—';
}

function formatHours(minutes: number) {
  const hours = minutes / 60;
  return `${hours.toLocaleString('en-KE', { maximumFractionDigits: 1 })} h`;
}

function formatTotals(totals: Record<string, number>) {
  const values = Object.entries(totals).filter(([, amount]) => amount !== 0);
  return values.length ? values.map(([currency, amount]) => fmtMoney(amount, currency)).join(' · ') : fmtMoney(0, 'KES');
}

function NairobiDayKey(timestamp: number) {
  return new Date(timestamp + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function toneForStatus(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'completed') return 'success';
  if (status === 'cancelled' || status === 'no-show') return 'danger';
  if (status === 'confirmed' || status === 'checked-in' || status === 'in-service') return 'info';
  return 'warning';
}

function StaffPerformance() {
  const [report, setReport] = useState<StaffPerformanceReport | null>(null);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('revenue');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    StaffPerformanceApi.lastWeek()
      .then(data => { if (active) setReport(data); })
      .catch((cause: any) => { if (active) setError(cause?.message || 'Could not load staff performance.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try { setReport(await StaffPerformanceApi.lastWeek()); }
    catch (cause: any) { setError(cause?.message || 'Could not refresh staff performance.'); }
    finally { setRefreshing(false); }
  };

  const staffRows = report?.staff || [];
  const selected = staffRows.find(member => member.id === selectedStaffId) || staffRows[0] || null;
  const allServiceLines = staffRows.flatMap(member => member.services.lines);
  const uniqueServices = Array.from(new Map(allServiceLines.map(line => [line.lineId, line])).values());
  const allAppointments = Array.from(new Map(staffRows.flatMap(member => member.appointments.items).map(item => [item.id, item])).values());
  const allReviews = Array.from(new Map(staffRows.flatMap(member => member.reviews.items).map(item => [item.id, item])).values());
  const revenueTotals = uniqueServices.reduce((totals, line) => ({ ...totals, [line.currency]: (totals[line.currency] || 0) + line.attributedRevenue }), {} as Record<string, number>);
  const earningsTotals = staffRows.reduce((totals, member) => {
    for (const [currency, amount] of Object.entries(member.services.commission)) totals[currency] = (totals[currency] || 0) + amount;
    for (const [currency, amount] of Object.entries(member.services.assistant)) totals[currency] = (totals[currency] || 0) + amount;
    return totals;
  }, {} as Record<string, number>);
  const totalShiftHours = staffRows.reduce((sum, member) => sum + member.attendance.minutes, 0);
  const averageRating = allReviews.length ? allReviews.reduce((sum, review) => sum + review.rating, 0) / allReviews.length : 0;

  const visibleStaff = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const matching = staffRows.filter(member => !needle || `${member.name} ${member.role} ${member.branchName}`.toLocaleLowerCase().includes(needle));
    return matching.sort((first, second) => {
      if (sortKey === 'name') return first.name.localeCompare(second.name);
      const values: Record<Exclude<SortKey, 'name'>, (member: StaffPerformanceReport['staff'][number]) => number> = {
        revenue: member => member.services.revenue.KES || 0,
        completed: member => member.appointments.completed,
        earnings: member => (member.services.commission.KES || 0) + (member.services.assistant.KES || 0),
        hours: member => member.attendance.minutes,
        rating: member => member.reviews.count ? member.reviews.averageRating : -1,
      };
      return values[sortKey](second) - values[sortKey](first) || first.name.localeCompare(second.name);
    });
  }, [staffRows, search, sortKey]);

  const weekDays = useMemo(() => {
    if (!report) return [];
    const days: string[] = [];
    const cursor = new Date(`${report.period.fromDate}T00:00:00Z`);
    const end = new Date(`${report.period.toDate}T00:00:00Z`);
    while (cursor <= end) {
      days.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }, [report]);

  const trend = weekDays.map(date => ({
    date,
    revenue: uniqueServices.filter(line => NairobiDayKey(line.createdAt) === date).reduce((sum, line) => sum + (line.currency === 'KES' ? line.attributedRevenue : 0), 0),
    appointments: allAppointments.filter(item => item.date === date).length,
  }));
  const maxRevenue = Math.max(1, ...trend.map(day => day.revenue));
  const selectedLineCount = selected?.services.lines.length || 0;
  const selectedWork = selected?.appointments || null;

  const downloadReport = () => {
    if (!report) return;
    const rows: (string | number)[][] = [
      ['BRAIDY SALON - Staff Performance Review'],
      ['Period', `${report.period.fromDate} to ${report.period.toDate} (Nairobi)`],
      ['Service revenue is attributed to each staff member involved; salon total de-duplicates shared service lines.'],
      [],
      ['Staff summary', 'Role', 'Branch', 'Employment', 'Appointments', 'Completed', 'Cancelled', 'No-shows', 'Queue handled', 'Queue served', 'Service lines', 'Units', 'Revenue KES', 'Revenue USD', 'Commission KES', 'Assistant KES', 'Paid KES', 'Unpaid KES', 'Attendance days', 'Shifts complete', 'Hours', 'Reviews', 'Average rating'],
      ...staffRows.map(member => [member.name, member.role, member.branchName, member.employmentStatus, member.appointments.total, member.appointments.completed, member.appointments.cancelled, member.appointments.noShow, member.queue.handled, member.queue.served, member.services.count, member.services.units, member.services.revenue.KES || 0, member.services.revenue.USD || 0, member.services.commission.KES || 0, member.services.assistant.KES || 0, member.services.paid.KES || 0, member.services.unpaid.KES || 0, member.attendance.days, member.attendance.completedShifts, Math.round(member.attendance.minutes / 60 * 10) / 10, member.reviews.count, Math.round(member.reviews.averageRating * 100) / 100]),
      [],
      ['Service detail', 'Staff', 'Date', 'Customer', 'Service', 'Quantity', 'Currency', 'Attributed revenue', 'Commission', 'Assistant earnings', 'Paid', 'Unpaid', 'Work roles'],
      ...staffRows.flatMap(member => member.services.lines.map(line => [member.name, new Date(line.createdAt).toISOString(), line.customerName, line.serviceName, line.quantity, line.currency, line.attributedRevenue, line.commission, line.assistant, line.paid, line.unpaid, line.roles.join(', ')])),
      [],
      ['Review detail', 'Staff', 'Date', 'Rating', 'Customer', 'Service', 'Comment'],
      ...staffRows.flatMap(member => member.reviews.items.map(review => [member.name, new Date(review.createdAt).toISOString(), review.rating, review.customerName, review.serviceName, review.comment])),
      [],
      ['Shift detail', 'Staff', 'Date', 'Check in', 'Check out', 'Minutes'],
      ...staffRows.flatMap(member => member.attendance.shifts.map(shift => [member.name, shift.date, new Date(shift.checkInAt).toISOString(), shift.checkOutAt ? new Date(shift.checkOutAt).toISOString() : '', shift.minutes])),
    ];
    downloadCSV(`braidy-staff-performance-${report.period.fromDate}-to-${report.period.toDate}.csv`, rows);
  };

  if (loading) return <LoadingState label="Building last week's staff review…" />;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#0f766e]">Weekly review</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Staff Performance</h1>
          <p className="text-sm text-[#6E6E73]">{report ? `${formatDate(report.period.fromDate, { day: 'numeric', month: 'long' })} – ${formatDate(report.period.toDate, { day: 'numeric', month: 'long', year: 'numeric' })} · Nairobi time` : 'Previous complete Sunday–Saturday period'}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={15} aria-hidden="true" />{refreshing ? 'Refreshing…' : 'Refresh'}</Button>
          <Button onClick={downloadReport} disabled={!report}><Download size={15} aria-hidden="true" />Export CSV</Button>
        </div>
      </div>

      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      {!report ? <Card className="p-6 text-sm text-[#6E6E73]">Performance data could not be loaded. Refresh to retry.</Card> : <>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <StatCard label="Service revenue" value={formatTotals(revenueTotals)} sub={`${uniqueServices.length} distinct service lines`} icon={Activity} tone="success" />
          <StatCard label="Completed appointments" value={String(allAppointments.filter(item => item.status === 'completed').length)} sub={`${allAppointments.length} assigned appointments`} icon={CalendarDays} />
          <StatCard label="Staff earnings" value={formatTotals(earningsTotals)} sub="Commission + assistant work" icon={Scissors} tone="success" />
          <StatCard label="Tracked shift hours" value={formatHours(totalShiftHours)} sub="From recorded check-in/out pairs" icon={Clock3} />
          <StatCard label="Client rating" value={allReviews.length ? `${averageRating.toFixed(1)} / 5` : '—'} sub={`${allReviews.length} reviews in period`} icon={Star} tone={averageRating >= 4 ? 'success' : averageRating > 0 ? 'warning' : 'neutral'} />
        </div>

        <section className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <Card className="p-5">
            <div className="mb-4 flex items-start justify-between gap-3"><div><h2 className="font-semibold">Daily service revenue</h2><p className="text-xs text-[#6E6E73]">KES · de-duplicated across shared staff assignments</p></div><Activity size={17} className="text-[#0f766e]" aria-hidden="true" /></div>
            <div className="grid h-36 grid-cols-7 items-end gap-2 border-b border-black/10 pb-2">
              {trend.map(day => <div key={day.date} className="flex h-full flex-col items-center justify-end gap-2" title={`${formatDate(day.date)} · ${fmtMoney(day.revenue, 'KES')}`}>
                <span className="text-[10px] text-[#6E6E73]">{day.revenue ? Math.round(day.revenue / 1000 * 10) / 10 + 'k' : ''}</span>
                <div className="w-full max-w-10 rounded-t-sm bg-[#0f766e]" style={{ height: `${Math.max(4, day.revenue / maxRevenue * 72)}%` }} />
                <span className="text-[10px] text-[#6E6E73]">{formatDate(day.date, { weekday: 'short' })}</span>
              </div>)}
            </div>
          </Card>
          <Card className="p-5">
            <div className="mb-4 flex items-start justify-between gap-3"><div><h2 className="font-semibold">Service & client outcomes</h2><p className="text-xs text-[#6E6E73]">Assigned appointments in the same period</p></div><Users size={17} className="text-[#17679a]" aria-hidden="true" /></div>
            <div className="space-y-3">
              {[
                { label: 'Completed', count: allAppointments.filter(item => item.status === 'completed').length, tone: 'bg-[#15803d]' },
                { label: 'Cancelled', count: allAppointments.filter(item => item.status === 'cancelled').length, tone: 'bg-[#dc2626]' },
                { label: 'No-show', count: allAppointments.filter(item => item.status === 'no-show').length, tone: 'bg-[#d97706]' },
                { label: 'Open / other', count: allAppointments.filter(item => !['completed', 'cancelled', 'no-show'].includes(item.status)).length, tone: 'bg-[#64748b]' },
              ].map(outcome => {
                const total = Math.max(1, allAppointments.length);
                return <div key={outcome.label}>
                  <div className="mb-1 flex justify-between text-xs"><span>{outcome.label}</span><span className="font-medium">{outcome.count}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-black/5"><div className={`h-full ${outcome.tone}`} style={{ width: `${outcome.count / total * 100}%` }} /></div>
                </div>;
              })}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-black/5 pt-4">
              <div><p className="text-xs text-[#6E6E73]">Queue entries handled</p><p className="mt-1 text-lg font-semibold">{staffRows.reduce((sum, member) => sum + member.queue.handled, 0)}</p></div>
              <div><p className="text-xs text-[#6E6E73]">Queue entries served</p><p className="mt-1 text-lg font-semibold">{staffRows.reduce((sum, member) => sum + member.queue.served, 0)}</p></div>
            </div>
          </Card>
        </section>

        <section className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div><h2 className="text-lg font-semibold">Staff comparison</h2><p className="text-sm text-[#6E6E73]">Select a staff member to review work, attendance, earnings, and feedback.</p></div>
            <div className="flex gap-2">
              <label className="relative min-w-0 flex-1 sm:w-56"><Search size={15} className="absolute left-3 top-3 text-[#6E6E73]" aria-hidden="true" /><Input aria-label="Search staff" placeholder="Search staff" value={search} onChange={event => setSearch(event.target.value)} className="pl-9" /></label>
              <Select aria-label="Sort staff" value={sortKey} onChange={event => setSortKey(event.target.value as SortKey)} className="w-auto min-w-32">
                <option value="revenue">Revenue</option><option value="completed">Completed</option><option value="earnings">Earnings</option><option value="hours">Hours</option><option value="rating">Rating</option><option value="name">Name</option>
              </Select>
            </div>
          </div>
          <div className="overflow-x-auto rounded-xl border border-black/10 bg-white">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-black/5 bg-black/[0.02] text-xs text-[#6E6E73]"><tr><th className="px-4 py-3 font-medium">Staff member</th><th className="px-4 py-3 font-medium">Appointments</th><th className="px-4 py-3 font-medium">Services</th><th className="px-4 py-3 font-medium">Revenue</th><th className="px-4 py-3 font-medium">Earnings</th><th className="px-4 py-3 font-medium">Attendance</th><th className="px-4 py-3 font-medium">Reviews</th></tr></thead>
              <tbody>{visibleStaff.map(member => {
                const active = selected?.id === member.id;
                return <tr key={member.id} onClick={() => setSelectedStaffId(member.id)} className={`cursor-pointer border-b border-black/5 last:border-0 ${active ? 'bg-[#ecfdf5]' : 'hover:bg-black/[0.02]'}`} aria-selected={active}>
                  <td className="px-4 py-3"><p className="font-medium">{member.name}</p><p className="text-xs capitalize text-[#6E6E73]">{member.role}{member.branchName ? ` · ${member.branchName}` : ''}</p></td>
                  <td className="px-4 py-3"><span className="font-medium">{member.appointments.completed}</span><span className="text-[#6E6E73]"> / {member.appointments.total}</span><p className="text-xs text-[#6E6E73]">{member.appointments.cancelled} cancelled · {member.appointments.noShow} no-show</p></td>
                  <td className="px-4 py-3">{member.services.count}<p className="text-xs text-[#6E6E73]">{member.services.units} units</p></td>
                  <td className="px-4 py-3 font-medium">{formatTotals(member.services.revenue)}</td>
                  <td className="px-4 py-3">{formatTotals({ KES: (member.services.commission.KES || 0) + (member.services.assistant.KES || 0), USD: (member.services.commission.USD || 0) + (member.services.assistant.USD || 0) })}<p className="text-xs text-[#6E6E73]">{formatTotals(member.services.unpaid)} unpaid</p></td>
                  <td className="px-4 py-3">{member.attendance.days} days<p className="text-xs text-[#6E6E73]">{formatHours(member.attendance.minutes)}</p></td>
                  <td className="px-4 py-3">{member.reviews.count ? <><span className="inline-flex items-center gap-1 font-medium"><Star size={13} className="fill-[#d89b00] text-[#d89b00]" aria-hidden="true" />{member.reviews.averageRating.toFixed(1)}</span><p className="text-xs text-[#6E6E73]">{member.reviews.count} review{member.reviews.count === 1 ? '' : 's'}</p></> : <span className="text-[#6E6E73]">No reviews</span>}</td>
                </tr>;
              })}</tbody>
            </table>
            {visibleStaff.length === 0 && <p className="p-6 text-center text-sm text-[#6E6E73]">No staff match this search.</p>}
          </div>
        </section>

        {selected && <section className="space-y-4" aria-label={`${selected.name} performance detail`}>
          <div className="flex flex-col gap-2 border-b border-black/10 pb-3 sm:flex-row sm:items-end sm:justify-between">
            <div><p className="text-xs font-semibold uppercase tracking-wide text-[#0f766e]">Individual review</p><h2 className="mt-1 text-xl font-semibold">{selected.name}</h2><p className="text-sm capitalize text-[#6E6E73]">{selected.role}{selected.branchName ? ` · ${selected.branchName}` : ''} · {selected.employmentStatus}</p></div>
            <Badge tone={selected.appointments.completed > 0 || selected.services.count > 0 ? 'success' : 'neutral'}>{selected.services.count} service lines · {selected.appointments.completed} completed appointments</Badge>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-5">
              <h3 className="mb-3 flex items-center gap-2 font-semibold"><CalendarDays size={16} aria-hidden="true" />Appointments & queue</h3>
              <div className="grid grid-cols-2 gap-y-3 text-sm">
                <span className="text-[#6E6E73]">Completed</span><strong>{selected.appointments.completed}</strong>
                <span className="text-[#6E6E73]">Cancelled</span><strong>{selected.appointments.cancelled}</strong>
                <span className="text-[#6E6E73]">No-show</span><strong>{selected.appointments.noShow}</strong>
                <span className="text-[#6E6E73]">Open / other</span><strong>{selected.appointments.open}</strong>
                <span className="text-[#6E6E73]">Booked minutes</span><strong>{selected.appointments.minutes}</strong>
                <span className="text-[#6E6E73]">Queue served</span><strong>{selected.queue.served} / {selected.queue.handled}</strong>
              </div>
            </Card>
            <Card className="p-5">
              <h3 className="mb-3 flex items-center gap-2 font-semibold"><Clock3 size={16} aria-hidden="true" />Attendance</h3>
              <div className="grid grid-cols-2 gap-y-3 text-sm">
                <span className="text-[#6E6E73]">Days present</span><strong>{selected.attendance.days}</strong>
                <span className="text-[#6E6E73]">Check-ins</span><strong>{selected.attendance.checkIns}</strong>
                <span className="text-[#6E6E73]">Completed shifts</span><strong>{selected.attendance.completedShifts}</strong>
                <span className="text-[#6E6E73]">No checkout</span><strong>{selected.attendance.incompleteShifts}</strong>
                <span className="text-[#6E6E73]">Recorded hours</span><strong>{formatHours(selected.attendance.minutes)}</strong>
                <span className="text-[#6E6E73]">Punctuality</span><span className="text-right text-xs text-[#6E6E73]">No shift schedule stored</span>
              </div>
            </Card>
            <Card className="p-5">
              <h3 className="mb-3 flex items-center gap-2 font-semibold"><Scissors size={16} aria-hidden="true" />Earnings breakdown</h3>
              <div className="grid grid-cols-2 gap-y-3 text-sm">
                <span className="text-[#6E6E73]">Attributed service value</span><strong>{formatTotals(selected.services.revenue)}</strong>
                <span className="text-[#6E6E73]">Commission</span><strong>{formatTotals(selected.services.commission)}</strong>
                <span className="text-[#6E6E73]">Assistant earnings</span><strong>{formatTotals(selected.services.assistant)}</strong>
                <span className="text-[#6E6E73]">Paid</span><strong>{formatTotals(selected.services.paid)}</strong>
                <span className="text-[#6E6E73]">Unpaid</span><strong>{formatTotals(selected.services.unpaid)}</strong>
                <span className="text-[#6E6E73]">Product cost</span><strong>{formatTotals(selected.services.productCost)}</strong>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-black/5 px-5 py-4"><div><h3 className="font-semibold">Service work</h3><p className="text-xs text-[#6E6E73]">{selectedLineCount} service lines attributed during the period</p></div><Scissors size={17} className="text-[#0f766e]" aria-hidden="true" /></div>
              {selected.services.lines.length === 0 ? <p className="p-5 text-sm text-[#6E6E73]">No service earnings were recorded for this staff member.</p> : <div className="max-h-[440px] divide-y divide-black/5 overflow-y-auto">
                {selected.services.lines.map(line => <div key={line.lineId} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><p className="truncate text-sm font-medium">{line.serviceName} <span className="font-normal text-[#6E6E73]">× {line.quantity}</span></p><p className="truncate text-xs text-[#6E6E73]">{line.customerName} · {formatDate(NairobiDayKey(line.createdAt), { day: 'numeric', month: 'short' })} · {line.roles.join(', ')}</p></div>
                  <div className="shrink-0 text-left sm:text-right"><p className="text-sm font-medium">{fmtMoney(line.attributedRevenue, line.currency)}</p><p className="text-xs text-[#6E6E73]">Earned {fmtMoney(line.commission + line.assistant, line.currency)} · unpaid {fmtMoney(line.unpaid, line.currency)}</p></div>
                </div>)}
              </div>}
            </Card>

            <div className="space-y-4">
              <Card className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-black/5 px-5 py-4"><div><h3 className="font-semibold">Client feedback</h3><p className="text-xs text-[#6E6E73]">{selected.reviews.count ? `${selected.reviews.averageRating.toFixed(1)} average from ${selected.reviews.count} review${selected.reviews.count === 1 ? '' : 's'}` : 'No feedback recorded this week'}</p></div><MessageSquare size={17} className="text-[#17679a]" aria-hidden="true" /></div>
                {selected.reviews.count > 0 && <div className="space-y-2 border-b border-black/5 px-5 py-3">
                  {[5, 4, 3, 2, 1].map(rating => <div key={rating} className="flex items-center gap-2 text-xs"><span className="w-6 text-[#6E6E73]">{rating}★</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/5"><div className="h-full bg-[#d89b00]" style={{ width: `${selected.reviews.count ? selected.reviews.distribution[rating as 1 | 2 | 3 | 4 | 5] / selected.reviews.count * 100 : 0}%` }} /></div><span className="w-5 text-right text-[#6E6E73]">{selected.reviews.distribution[rating as 1 | 2 | 3 | 4 | 5]}</span></div>)}
                </div>}
                <div className="max-h-64 divide-y divide-black/5 overflow-y-auto">
                  {selected.reviews.items.map(review => <div key={review.id} className="px-5 py-3"><div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-1 text-sm font-medium"><Star size={13} className="fill-[#d89b00] text-[#d89b00]" aria-hidden="true" />{review.rating}/5</span><span className="text-xs text-[#6E6E73]">{formatDate(NairobiDayKey(review.createdAt), { day: 'numeric', month: 'short' })}</span></div><p className="mt-1 text-xs text-[#6E6E73]">{review.customerName} · {review.serviceName}</p>{review.comment && <p className="mt-2 text-sm">{review.comment}</p>}</div>)}
                  {!selected.reviews.items.length && <p className="px-5 py-4 text-sm text-[#6E6E73]">No client reviews for this period.</p>}
                </div>
              </Card>

              <Card className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-black/5 px-5 py-4"><div><h3 className="font-semibold">Recorded shifts</h3><p className="text-xs text-[#6E6E73]">Check-in and check-out records</p></div><Clock3 size={17} className="text-[#0f766e]" aria-hidden="true" /></div>
                <div className="max-h-56 divide-y divide-black/5 overflow-y-auto">
                  {selected.attendance.shifts.map((shift, index) => <div key={`${shift.date}-${shift.checkInAt}-${index}`} className="flex items-center justify-between gap-3 px-5 py-3 text-sm"><div><p className="font-medium">{formatDate(shift.date, { weekday: 'short', day: 'numeric', month: 'short' })}</p><p className="text-xs text-[#6E6E73]">{formatTime(shift.checkInAt)} – {formatTime(shift.checkOutAt)}</p></div><span className="shrink-0 text-xs text-[#6E6E73]">{shift.minutes ? formatHours(shift.minutes) : 'Incomplete'}</span></div>)}
                  {!selected.attendance.shifts.length && <p className="px-5 py-4 text-sm text-[#6E6E73]">No attendance record found for this period.</p>}
                </div>
              </Card>
            </div>
          </div>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-black/5 px-5 py-4"><div><h3 className="font-semibold">Appointment outcomes</h3><p className="text-xs text-[#6E6E73]">Client bookings assigned to {selected.name}</p></div><CalendarDays size={17} className="text-[#17679a]" aria-hidden="true" /></div>
            <div className="max-h-80 overflow-auto">
              {selectedWork?.items.length ? <table className="w-full min-w-[620px] text-left text-sm"><thead className="sticky top-0 bg-white text-xs text-[#6E6E73]"><tr><th className="px-5 py-3 font-medium">Date</th><th className="px-5 py-3 font-medium">Time</th><th className="px-5 py-3 font-medium">Client</th><th className="px-5 py-3 font-medium">Service</th><th className="px-5 py-3 font-medium">Outcome</th></tr></thead><tbody>{selectedWork.items.map(item => <tr key={item.id} className="border-t border-black/5"><td className="px-5 py-3">{formatDate(item.date, { day: 'numeric', month: 'short' })}</td><td className="px-5 py-3">{item.time || '—'}</td><td className="px-5 py-3">{item.customerName}</td><td className="px-5 py-3">{item.serviceName}</td><td className="px-5 py-3"><Badge tone={toneForStatus(item.status)}>{item.status}</Badge></td></tr>)}</tbody></table> : <p className="p-5 text-sm text-[#6E6E73]">No appointment records for this period.</p>}
            </div>
          </Card>
        </section>}

        <p className="text-xs text-[#6E6E73]">Revenue is counted once for the salon total and attributed to each participating staff member in individual detail. Attendance hours use completed check-in/out pairs; punctuality cannot be assessed because staff schedules are not stored.</p>
      </>}
    </div>
  );
}

export default StaffPerformance;