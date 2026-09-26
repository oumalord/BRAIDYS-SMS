import { useEffect, useState } from 'react';
import { DollarSign, Calendar, Users, AlertTriangle, TrendingUp, Sparkles } from 'lucide-react';
import { Card, StatCard, LoadingState, EmptyState, toast } from '../components/ui';
import { DashboardApi, RebookingApi, PayrollApi, fmtMoney } from '../lib/api';
import type { DashboardData, RebookingItem, Staff } from '../types';

type Range = 'today' | 'week' | 'month' | 'all';

function Dashboard() {
  const [range, setRange] = useState<Range>('today');
  const [data, setData] = useState<DashboardData | null>(null);
  const [rebooking, setRebooking] = useState<RebookingItem[]>([]);
  const [ownerStaffEarnings, setOwnerStaffEarnings] = useState<Staff[]>([]);
  const [earningsPeriod, setEarningsPeriod] = useState<{ from: number; to: number } | null>(null);
  const [earningsLoading, setEarningsLoading] = useState(true);
  const [earningsError, setEarningsError] = useState('');
  const [dashboardError, setDashboardError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setEarningsLoading(true);
    setEarningsError('');
    setDashboardError('');
    DashboardApi.get(range)
      .then(d => { if (alive) setData(d); })
      .catch((cause: any) => {
        if (!alive) return;
        setDashboardError(cause?.message || 'Could not load dashboard data.');
        toast('Could not load dashboard metrics.', 'error');
      })
      .finally(() => { if (alive) setLoading(false); });
    RebookingApi.list()
      .then(items => { if (alive) setRebooking(items); })
      .catch(() => { if (alive) toast('Could not load rebooking suggestions.', 'error'); });
    PayrollApi.staff()
      .then(payroll => {
        if (!alive) return;
        setOwnerStaffEarnings(payroll.items);
        setEarningsPeriod(payroll.period);
      })
      .catch((cause: any) => {
        if (!alive) return;
        setEarningsError(cause?.message || 'Weekly staff earnings are temporarily unavailable.');
        toast('Could not load weekly staff earnings. Other dashboard data is still available.', 'error');
      })
      .finally(() => { if (alive) setEarningsLoading(false); });
    return () => { alive = false; };
  }, [range]);

  if (loading && !data) return <LoadingState label="Loading dashboard…" />;
  if (!data) return <EmptyState icon={AlertTriangle} title="Dashboard data unavailable" description={dashboardError || 'Could not load your business data. Please try again shortly.'} />;

  const maxTrend = Math.max(1, ...data.trend.map(t => t.revenue));
  const revenueKES = data.revenueByCurrency.KES || 0;
  const revenueUSD = data.revenueByCurrency.USD || 0;
  const profitKES = data.estimatedProfitByCurrency.KES || 0;
  const earningsDateRange = earningsPeriod
    ? `${new Date(earningsPeriod.from).toLocaleDateString()} – ${new Date(earningsPeriod.to).toLocaleDateString()}`
    : 'Sunday–Saturday';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Business Dashboard</h1>
          <p className="text-sm text-[#6E6E73]">Live metrics computed from your recorded appointments, sales and expenses.</p>
        </div>
        <div className="flex gap-1 bg-black/5 rounded-full p-1 w-fit" role="group" aria-label="Date range">
          {(['today', 'week', 'month', 'all'] as const).map(r => (
            <button key={r} onClick={() => setRange(r)} aria-pressed={range === r} className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${range === r ? 'bg-white shadow-sm text-[#1D1D1F]' : 'text-[#6E6E73]'}`}>
              {r === 'today' ? 'Today' : r === 'week' ? 'This Week' : r === 'month' ? 'This Month' : 'All Time'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 sm:gap-4">
        <StatCard label="Revenue" value={fmtMoney(revenueKES, 'KES')} sub={revenueUSD > 0 ? `+ ${fmtMoney(revenueUSD, 'USD')} · ${data.ordersCount} transactions` : `${data.ordersCount} transactions`} icon={DollarSign} tone="success" />
        <StatCard label="Estimated Profit" value={fmtMoney(profitKES, 'KES')} sub="After cost, commission, salaries & expenses" icon={TrendingUp} tone={profitKES >= 0 ? 'success' : 'danger'} />
        <StatCard label="Appointments Today" value={String(data.todaysAppointmentsCount)} sub={`${data.waitingQueueCount} waiting in queue`} icon={Calendar} />
        <StatCard label="Active Staff" value={`${data.activeStaffCount}/${data.totalStaffCount}`} sub="currently on shift" icon={Users} />
        <StatCard label="Registered Customers" value={String(data.customersCount)} sub="all customer profiles" icon={Users} />
      </div>

      <Card className="p-4 sm:p-6">
        <div className="mb-4"><h2 className="font-semibold">Staff Earnings · Sunday–Saturday</h2><p className="text-xs text-[#6E6E73]">Unpaid earnings from {earningsDateRange}. Includes commission and assistant-only earnings for every staff member.</p></div>
        {earningsLoading ? <p className="text-sm text-[#6E6E73]">Loading weekly staff earnings…</p> : earningsError ? <p role="status" className="text-sm text-amber-700">{earningsError} Business metrics are available above.</p> : ownerStaffEarnings.length === 0 ? <p className="text-sm text-[#6E6E73]">No staff records are available.</p> : <div className="space-y-2">{[...ownerStaffEarnings].sort((first, second) => ((second.commissionEarnedWeek || 0) + (second.assistantEarnedWeek || 0)) - ((first.commissionEarnedWeek || 0) + (first.assistantEarnedWeek || 0))).map(member => { const commission = member.commissionEarnedWeek || 0; const assistant = member.assistantEarnedWeek || 0; return <div key={member.id} className="flex items-center justify-between gap-3 border-b border-black/5 pb-2 last:border-0"><div><p className="text-sm font-medium">{member.name}</p><p className="text-xs text-[#6E6E73]">Commission {fmtMoney(commission, 'KES')} · assistant earnings {fmtMoney(assistant, 'KES')}</p></div><p className="shrink-0 text-sm font-semibold">{fmtMoney(commission + assistant, 'KES')}</p></div>; })}</div>}
      </Card>

      <div className="grid grid-cols-1 gap-4">
        <Card className="p-4 sm:p-6">
          <h2 className="font-semibold mb-4">Last 7 Days Revenue (KES)</h2>
          <div className="flex items-end gap-2 h-40" aria-hidden="true">
            {data.trend.map(t => (
              <div key={t.date} className="flex-1 flex flex-col items-center gap-2">
                <div className="w-full bg-[#0071e3] rounded-t-lg transition-all" style={{ height: `${Math.max(4, (t.revenue / maxTrend) * 100)}%` }} />
                <span className="text-[10px] text-[#6E6E73]">{t.date.slice(5)}</span>
              </div>
            ))}
          </div>
          <table className="sr-only">
            <caption>Daily revenue for the last 7 days</caption>
            <thead><tr><th>Date</th><th>Revenue</th></tr></thead>
            <tbody>{data.trend.map(t => <tr key={t.date}><td>{t.date}</td><td>{fmtMoney(t.revenue, 'KES')}</td></tr>)}</tbody>
          </table>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-3 p-4 sm:p-6">
          <h2 className="font-semibold mb-4">Registered Customers</h2>
          {data.customers.length === 0 ? <p className="text-sm text-[#6E6E73]">No customer profiles registered yet.</p> : <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{data.customers.map(customer => <div key={customer.id} className="flex items-center justify-between border-b border-black/5 pb-2 text-sm"><span>{customer.name}</span><span className="text-xs text-[#6E6E73]">{customer.phone || customer.email || 'No contact'}</span></div>)}</div>}
        </Card>
        <Card className="p-4 sm:p-4 sm:p-6">
          <h2 className="font-semibold mb-4">Top Staff by Earnings</h2>
          {data.topStaff.length === 0 ? <p className="text-sm text-[#6E6E73]">No sales recorded yet.</p> : (
            <ul className="space-y-3">
              {data.topStaff.map(s => (
                <li key={`${s.name}-${s.currency}`} className="flex items-center justify-between text-sm">
                  <span>{s.name}</span>
                  <span className="font-medium">{fmtMoney(s.commission, s.currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4 sm:p-6">
          <h2 className="font-semibold mb-4">Top Services</h2>
          {data.topServices.length === 0 ? <p className="text-sm text-[#6E6E73]">No sales recorded yet.</p> : (
            <ul className="space-y-3">
              {data.topServices.map(s => (
                <li key={`${s.name}-${s.currency}`} className="flex items-center justify-between text-sm">
                  <span>{s.name}</span>
                  <span className="font-medium">{fmtMoney(s.revenue, s.currency)} · {s.count}x</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4 sm:p-6">
          <h2 className="font-semibold mb-4 flex items-center gap-2"><Sparkles size={16} className="text-[#0071e3]" aria-hidden="true" />Smart Rebooking</h2>
          {rebooking.length === 0 ? <p className="text-sm text-[#6E6E73]">No customers are predicted to be due for a visit this week.</p> : (
            <ul className="space-y-3">
              {rebooking.slice(0, 5).map(r => (
                <li key={r.customerId} className="text-sm">
                  <p className="font-medium">{r.customerName}</p>
                  <p className="text-xs text-[#6E6E73]">Usually returns every {r.avgIntervalDays} days · due {r.daysUntil <= 0 ? 'now' : `in ${r.daysUntil}d`}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card className="p-4 sm:p-6">
        <h2 className="font-semibold mb-4">Service income by client</h2>
        {data.commissionByClient.length === 0 ? <p className="text-sm text-[#6E6E73]">No paid services recorded for this range.</p> : <div className="space-y-2 text-sm">{data.commissionByClient.slice(-12).reverse().map((item, index) => <div key={`${item.clientId || item.clientName}-${item.createdAt}-${index}`} className="grid gap-1 border-b border-black/5 pb-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center"><span>{item.clientName}</span><span className="text-[#6E6E73]">{item.serviceName} · {item.staffName}</span><span className="font-medium">{fmtMoney(item.commission, item.currency)} expected</span></div>)}</div>}
      </Card>
    </div>
  );
}

export default Dashboard;
