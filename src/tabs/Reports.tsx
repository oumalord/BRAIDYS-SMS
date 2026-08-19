import { useEffect, useState } from 'react';
import { Download, TrendingUp, Users, Calendar, ShoppingCart } from 'lucide-react';
import { Card, Button, Select, StatCard, LoadingState } from '../components/ui';
import { DashboardApi, StaffApi, AppointmentsApi, QueueApi, fmtMoney, downloadCSV } from '../lib/api';
import type { DashboardData, Staff, Appointment, QueueEntry, Role } from '../types';

type Range = 'today' | 'week' | 'month' | 'all';

function cutoffMs(range: Range) {
  const now = Date.now();
  if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (range === 'week') return now - 7 * 24 * 3600 * 1000;
  if (range === 'month') return now - 30 * 24 * 3600 * 1000;
  return 0;
}

function OwnerReport({ range }: { range: Range }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([DashboardApi.get(range), StaffApi.list()]).then(([d, s]) => { setData(d); setStaff(s); }).finally(() => setLoading(false));
  }, [range]);

  if (loading || !data) return <LoadingState label="Building report…" />;

  const revenueKES = data.revenueByCurrency.KES || 0;
  const commissionsKES = data.commissionsByCurrency.KES || 0;
  const profitKES = data.estimatedProfitByCurrency.KES || 0;

  const commissionStatement = staff.map(s => {
    const perf = data.topStaff.filter(t => t.name === s.name);
    const commission = perf.reduce((sum, p) => sum + (p.currency === 'KES' ? p.commission : 0), 0);
    const serviceRevenue = perf.reduce((sum, p) => sum + (p.currency === 'KES' ? p.revenue : 0), 0);
    return { name: s.name, role: s.role, serviceRevenue, commission };
  });

  const handleDownload = () => {
    const rows: (string | number)[][] = [
      ['SafiGroom OS - Owner Business Report'],
      ['Range', range],
      [],
      ['Revenue (KES)', revenueKES],
      ['Product Cost (KES)', data.productCost],
      ['Commissions (KES)', commissionsKES],
      ['Expenses (KES)', data.expenseTotal],
      ['Net Profit after commission and expenses (KES)', profitKES],
      [],
      ['Staff', 'Role', 'Service Revenue (KES)', 'Commission Rate', 'Commission Earned (KES)'],
      ...commissionStatement.map(p => [p.name, p.role, Math.round(p.serviceRevenue), '40%', Math.round(p.commission)]),
    ];
    downloadCSV(`safigroom-owner-report-${range}.csv`, rows);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Revenue" value={fmtMoney(revenueKES, 'KES')} icon={TrendingUp} tone="success" />
        <StatCard label="Commission Rate" value="40%" sub="Completed service work" icon={Users} />
        <StatCard label="Commissions" value={fmtMoney(commissionsKES, 'KES')} icon={Users} />
        <StatCard label="Net Profit" value={fmtMoney(profitKES, 'KES')} icon={TrendingUp} tone={profitKES >= 0 ? 'success' : 'danger'} />
      </div>

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Staff Commission Statement</h2>
          <Button variant="secondary" size="sm" onClick={handleDownload}><Download size={14} aria-hidden="true" />Download CSV</Button>
        </div>
        <table className="w-full text-sm">
          <caption className="sr-only">Staff commission statement</caption>
          <thead><tr className="text-left text-xs text-[#6E6E73] border-b border-black/5"><th className="pb-2">Staff</th><th className="pb-2">Role</th><th className="pb-2">Service Revenue</th><th className="pb-2">Commission</th></tr></thead>
          <tbody>
            {commissionStatement.map(p => (
              <tr key={p.name} className="border-b border-black/5 last:border-0">
                <td className="py-2">{p.name}</td>
                <td className="py-2">{p.role}</td>
                <td className="py-2">{fmtMoney(p.serviceRevenue, 'KES')}</td>
                <td className="py-2">{fmtMoney(p.commission, 'KES')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-[#6E6E73] mt-3">Each employee receives exactly 40% of their completed service revenue. Net profit subtracts commissions, product cost and recorded expenses.</p>
      </Card>
    </div>
  );
}

function ReceptionistReport({ range }: { range: Range }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([DashboardApi.get(range), AppointmentsApi.list(), QueueApi.list()]).then(([d, a, q]) => { setData(d); setAppts(a); setQueue(q); }).finally(() => setLoading(false));
  }, [range]);

  if (loading || !data) return <LoadingState label="Building report…" />;

  const cutoff = cutoffMs(range);
  const revenueKES = data.revenueByCurrency.KES || 0;
  const inRangeAppts = appts.filter(a => new Date(a.date).getTime() >= cutoff);
  const completed = inRangeAppts.filter(a => a.status === 'completed').length;
  const cancelled = inRangeAppts.filter(a => a.status === 'cancelled').length;
  const noShow = inRangeAppts.filter(a => a.status === 'no-show').length;
  const inRangeQueue = queue.filter(q => q.joinedAt >= cutoff);
  const queueServed = inRangeQueue.filter(q => q.status === 'completed').length;

  const handleDownload = () => {
    const rows: (string | number)[][] = [
      ['SafiGroom OS - Front Desk Performance Report'],
      ['Range', range],
      [],
      ['Appointments Booked', inRangeAppts.length],
      ['Completed', completed],
      ['Cancelled', cancelled],
      ['No-shows', noShow],
      ['Queue Entries Handled', inRangeQueue.length],
      ['Queue Entries Served', queueServed],
      ['POS Transactions Processed', data.ordersCount],
      ['Revenue Collected (KES)', revenueKES],
    ];
    downloadCSV(`safigroom-front-desk-report-${range}.csv`, rows);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Appointments Booked" value={String(inRangeAppts.length)} sub={`${completed} completed`} icon={Calendar} />
        <StatCard label="Cancelled / No-shows" value={`${cancelled} / ${noShow}`} icon={Calendar} tone={cancelled + noShow > 0 ? 'warning' : 'success'} />
        <StatCard label="Queue Served" value={`${queueServed}/${inRangeQueue.length}`} icon={Users} />
        <StatCard label="POS Transactions" value={String(data.ordersCount)} sub={fmtMoney(revenueKES, 'KES')} icon={ShoppingCart} />
      </div>
      <Card className="p-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold">Front Desk Performance</h2>
          <Button variant="secondary" size="sm" onClick={handleDownload}><Download size={14} aria-hidden="true" />Download CSV</Button>
        </div>
        <p className="text-sm text-[#6E6E73]">This report reflects appointments, queue handling and POS transactions recorded for the selected range. Share it with the owner as evidence of front-desk performance.</p>
      </Card>
    </div>
  );
}

function Reports({ role }: { role: Role }) {
  const [range, setRange] = useState<Range>('month');

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">Reports</h1><p className="text-sm text-[#6E6E73]">{role === 'owner' ? 'Full business performance, including commission costs.' : 'Your front-desk performance summary.'}</p></div>
        <Select aria-label="Report range" value={range} onChange={e => setRange(e.target.value as Range)} className="w-auto" style={{ width: 'auto' }}>
          <option value="today">Today</option><option value="week">This Week</option><option value="month">This Month</option><option value="all">All Time</option>
        </Select>
      </div>
      {role === 'owner' ? <OwnerReport range={range} /> : <ReceptionistReport range={range} />}
    </div>
  );
}

export default Reports;
