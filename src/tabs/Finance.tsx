import { useEffect, useState } from 'react';
import { Download, Plus, Receipt } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, EmptyState, LoadingState, StatCard, toast } from '../components/ui';
import { DashboardApi, downloadCSV, ExpensesApi, PayrollApi, PayoutsApi, fmtMoney } from '../lib/api';
import type { DashboardData, Expense, PayoutBatch, Staff } from '../types';

type Range = 'today' | 'week' | 'month' | 'all';

function Finance() {
  const [range, setRange] = useState<Range>('month');
  const [data, setData] = useState<DashboardData | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [payouts, setPayouts] = useState<PayoutBatch[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [payrollPeriod, setPayrollPeriod] = useState<{ from: number; to: number } | null>(null);
  const [payrollSending, setPayrollSending] = useState(false);
  const [paying, setPaying] = useState(false);
  const [deletingEarnings, setDeletingEarnings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [earningsDeleteOpen, setEarningsDeleteOpen] = useState(false);
  const [earningsDeleteRange, setEarningsDeleteRange] = useState({ from: '', to: '' });
  const [form, setForm] = useState({ category: 'Supplies', amount: 0, note: '', date: new Date().toISOString().slice(0, 10) });

  const load = () => {
    setLoading(true);
    Promise.all([DashboardApi.get(range), ExpensesApi.list(), PayoutsApi.list(), PayrollApi.staff()]).then(([d, e, p, payroll]) => { setData(d); setExpenses(e); setPayouts(p); setStaff(payroll.items); setPayrollPeriod(payroll.period); }).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const refresh = window.setInterval(load, 15000);
    return () => window.clearInterval(refresh);
  }, [range]);

  const addExpense = async () => {
    if (!form.category.trim() || form.amount <= 0) { toast('Enter a category and amount greater than zero.', 'error'); return; }
    await ExpensesApi.create(form);
    toast('Expense recorded.', 'success');
    setOpen(false);
    setForm({ category: 'Supplies', amount: 0, note: '', date: new Date().toISOString().slice(0, 10) });
    load();
  };

  const recordPayout = async () => {
    setPaying(true);
    try {
      const { data } = await PayoutsApi.record('week');
      toast(`${data.employeeCount} employees marked paid: ${fmtMoney(data.totalKES, 'KES')}. No money was sent.`, 'success');
      load();
    } catch (cause: any) {
      toast(cause?.message || 'Could not record the payout.', 'error');
    } finally {
      setPaying(false);
    }
  };

  const sendPayroll = async () => {
    const recipients = staff.map(member => ({ staffId: member.id, amountKES: (member.commissionEarnedWeek || 0) + (member.assistantEarnedWeek || 0), phone: member.phone })).filter(recipient => recipient.amountKES > 0);
    if (!recipients.length) { toast('Enter a salary amount for at least one employee.', 'error'); return; }
    if (recipients.some(recipient => !/^(?:\+?254|0)[17]\d{8}$/.test(recipient.phone.replace(/\s+/g, '')))) { toast('Every selected employee needs a valid Kenyan phone number.', 'error'); return; }
    if (!window.confirm(`Send ${fmtMoney(recipients.reduce((sum, recipient) => sum + recipient.amountKES, 0), 'KES')} to ${recipients.length} employees now?`)) return;
    setPayrollSending(true);
    try {
      const { data } = await PayrollApi.send(recipients);
      toast(`Payroll submitted: ${data.sentCount}/${data.employeeCount} transfers accepted by M-Pesa.`, 'success');
    } catch (cause: any) {
      toast(cause?.message || 'Payroll transfer failed.', 'error');
    } finally {
      setPayrollSending(false);
    }
  };

  const deletePaidEarnings = async () => {
    if (!earningsDeleteRange.from || !earningsDeleteRange.to) { toast('Choose both earnings dates.', 'error'); return; }
    const from = new Date(`${earningsDeleteRange.from}T00:00:00`).getTime();
    const to = new Date(`${earningsDeleteRange.to}T00:00:00`).getTime() + 24 * 3600 * 1000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) { toast('Choose a valid date range.', 'error'); return; }
    if (!window.confirm('Delete all paid staff earnings in this date range from staff dashboards and payroll? Orders and the payout audit trail will remain.')) return;
    setDeletingEarnings(true);
    try {
      const response = await PayoutsApi.deleteEarnings(from, to);
      toast(`${response.data.deleted} paid earning lines cleared: ${fmtMoney(response.data.totalKES, 'KES')}.`, 'success');
      setEarningsDeleteOpen(false);
      load();
    } catch (cause: any) {
      toast(cause?.message || 'Could not clear paid staff earnings.', 'error');
    } finally {
      setDeletingEarnings(false);
    }
  };

  if (loading && !data) return <LoadingState label="Loading finance data…" />;

  const revenueKES = data?.revenueByCurrency.KES || 0;
  const staffEarningsKES = data?.commissionsByCurrency.KES || 0;
  const profitKES = data?.estimatedProfitByCurrency.KES || 0;
  const payrollDateRange = payrollPeriod
    ? `${new Date(payrollPeriod.from).toLocaleDateString()} – ${new Date(payrollPeriod.to).toLocaleDateString()}`
    : 'Sunday–Saturday';
  const payrollStaff = staff.filter(member => member.employmentStatus !== 'laid-off');
  const downloadPayroll = () => {
    const startDate = payrollPeriod ? new Date(payrollPeriod.from) : new Date();
    const endDate = payrollPeriod ? new Date(payrollPeriod.to) : new Date();
    const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const totalCommission = payrollStaff.reduce((sum, member) => sum + (member.commissionEarnedWeek || 0), 0);
    const totalAssistant = payrollStaff.reduce((sum, member) => sum + (member.assistantEarnedWeek || 0), 0);
    const rows: (string | number)[][] = [
      ['SafiGroom weekly payroll'],
      ['Earnings period', payrollDateRange],
      ['Generated', new Date().toLocaleString()],
      [],
      ['Staff ID', 'Staff name', 'Role', 'Phone', 'Branch', 'Commission (KES)', 'Assistant earnings (KES)', 'Total earnings (KES)'],
      ...payrollStaff.map(member => {
        const commission = member.commissionEarnedWeek || 0;
        const assistant = member.assistantEarnedWeek || 0;
        return [member.id, member.name, member.role, member.phone || '', member.branchName || member.branch || '', commission, assistant, commission + assistant];
      }),
      [],
      ['TOTAL', '', '', '', '', totalCommission, totalAssistant, totalCommission + totalAssistant],
    ];
    downloadCSV(`safigroom-payroll-${dateKey(startDate)}-to-${dateKey(endDate)}.csv`, rows);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">Finance</h1><p className="text-sm text-[#6E6E73]">Revenue, commissions, expenses and profitability, computed from real transactions.</p></div>
        <div className="flex items-center gap-2">
          <Select aria-label="Date range" value={range} onChange={e => setRange(e.target.value as Range)} className="w-auto" style={{ width: 'auto' }}>
            <option value="today">Today</option><option value="week">This Week</option><option value="month">This Month</option><option value="all">All Time</option>
          </Select>
          <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />Add Expense</Button>
          <Button variant="secondary" onClick={recordPayout} disabled={paying}>{paying ? 'Recording…' : 'Mark weekly earnings paid'}</Button>
          <Button variant="danger" onClick={() => setEarningsDeleteOpen(true)}>Clear paid earnings</Button>
        </div>
      </div>

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Revenue" value={fmtMoney(revenueKES, 'KES')} icon={Receipt} tone="success" />
            <StatCard label="Product Cost" value={fmtMoney(data.productCost, 'KES')} icon={Receipt} />
            <StatCard label="Staff Earnings Owed" value={fmtMoney(staffEarningsKES, 'KES')} icon={Receipt} />
            <StatCard label="Commission Rate" value="50%" sub="After product and helper deductions" icon={Receipt} tone="warning" />
          </div>
          <Card className="p-6">
            <h2 className="font-semibold mb-4">Profitability Breakdown</h2>
            <div className="space-y-2 text-sm max-w-md">
              <div className="flex justify-between"><span className="text-[#6E6E73]">Revenue</span><span>{fmtMoney(revenueKES, 'KES')}</span></div>
              <div className="flex justify-between"><span className="text-[#6E6E73]">− Product cost (inventory consumed)</span><span>-{fmtMoney(data.productCost, 'KES')}</span></div>
              <div className="flex justify-between"><span className="text-[#6E6E73]">− Staff earnings</span><span>-{fmtMoney(staffEarningsKES, 'KES')}</span></div>
              <div className="flex justify-between"><span className="text-[#6E6E73]">− Recorded expenses</span><span>-{fmtMoney(data.expenseTotal, 'KES')}</span></div>
              <div className="flex justify-between font-semibold text-base border-t border-black/5 pt-2 mt-2"><span>Net Profit</span><span className={profitKES >= 0 ? 'text-[#1c7c34]' : 'text-[#b0201a]'}>{fmtMoney(profitKES, 'KES')}</span></div>
            </div>
            <p className="text-xs text-[#6E6E73] mt-3">Staff earnings include service commissions and separately recorded assistant compensation.</p>
          </Card>
          <Card className="p-6">
            <h2 className="font-semibold mb-4">Payment Methods</h2>
            <div className="grid sm:grid-cols-3 gap-3">
              {(['Cash', 'Card', 'M-Pesa'] as const).map(method => <div key={method} className="rounded-2xl bg-black/[0.03] p-4"><p className="text-xs text-[#6E6E73]">{method}</p><p className="text-xl font-semibold mt-1">{fmtMoney(data.paymentMethodTotals[method], 'KES')}</p></div>)}
            </div>
          </Card>
          <Card className="p-6">
            <h2 className="font-semibold mb-1">Staff Earnings (by staff)</h2>
            <p className="text-xs text-[#6E6E73] mb-4">Includes every staff member and earnings from completed services linked to them, including assistant-only work.</p>
            {data.staffEarnings.length === 0 ? <p className="text-sm text-[#6E6E73]">No staff records are available.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Commission and assistant earnings per staff member</caption>
                  <thead><tr className="text-left text-xs text-[#6E6E73] border-b border-black/5"><th className="pb-2 pr-3">Staff</th><th className="pb-2 pr-3">Services</th><th className="pb-2 pr-3">Service revenue</th><th className="pb-2 pr-3">Assistant fees deducted</th><th className="pb-2 pr-3">Commission</th><th className="pb-2 pr-3">Assistant earnings</th><th className="pb-2">Total earnings</th></tr></thead>
                  <tbody>
                    {data.staffEarnings.map(member => (
                      <tr key={`${member.staffId}-${member.currency}`} className="border-b border-black/5 last:border-0">
                        <td className="py-2 pr-3">{member.name}</td><td className="py-2 pr-3">{member.count}</td><td className="py-2 pr-3">{fmtMoney(member.revenue, member.currency)}</td><td className="py-2 pr-3">{fmtMoney(member.helperDeductions, member.currency)}</td><td className="py-2 pr-3">{fmtMoney(member.commission, member.currency)}</td><td className="py-2 pr-3">{fmtMoney(member.assistantEarnings, member.currency)}</td><td className="py-2 font-medium">{fmtMoney(member.commission + member.assistantEarnings, member.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4"><div><h2 className="font-semibold">Payroll</h2><p className="text-xs text-[#6E6E73]">Unpaid commissions and assistant earnings from {payrollDateRange}.</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={downloadPayroll} disabled={!payrollStaff.length}><Download size={16} aria-hidden="true" />Download payroll CSV</Button><Button onClick={sendPayroll} disabled={payrollSending}>{payrollSending ? 'Sending…' : 'Send payroll batch'}</Button></div></div>
        <div className="space-y-2">{payrollStaff.map(member => { const commission = member.commissionEarnedWeek || 0; const assistant = member.assistantEarnedWeek || 0; const calculated = commission + assistant; return <div key={member.id} className="flex items-center justify-between gap-3 border-b border-black/5 pb-2"><div><p className="text-sm font-medium">{member.name}</p><p className="text-xs text-[#6E6E73]">{member.phone || 'No phone number'} · {member.branchName || member.branch}</p><p className="text-xs text-[#6E6E73]">Commission {fmtMoney(commission, 'KES')} + assistant compensation {fmtMoney(assistant, 'KES')}</p></div><p className="font-semibold text-sm">{fmtMoney(calculated, 'KES')}</p></div>; })}</div>
      </Card>

      {earningsDeleteOpen && <Modal title="Clear paid staff earnings" onClose={() => setEarningsDeleteOpen(false)} footer={<><Button variant="secondary" onClick={() => setEarningsDeleteOpen(false)}>Cancel</Button><Button variant="danger" onClick={deletePaidEarnings} disabled={deletingEarnings}>{deletingEarnings ? 'Clearing…' : 'Clear earnings'}</Button></>}>
        <div className="space-y-4">
          <p className="text-sm text-[#6E6E73]">Choose the order dates whose paid earning lines should disappear from staff dashboards and payroll. Orders and payout history remain for audit.</p>
          <div className="grid sm:grid-cols-2 gap-4"><Field label="From" htmlFor="earnings-delete-from"><Input id="earnings-delete-from" type="date" value={earningsDeleteRange.from} onChange={event => setEarningsDeleteRange(current => ({ ...current, from: event.target.value }))} /></Field><Field label="To" htmlFor="earnings-delete-to"><Input id="earnings-delete-to" type="date" value={earningsDeleteRange.to} onChange={event => setEarningsDeleteRange(current => ({ ...current, to: event.target.value }))} /></Field></div>
        </div>
      </Modal>}

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4"><div><h2 className="font-semibold">Recorded payouts</h2><p className="text-xs text-[#6E6E73]">This records internal payment completion only. It does not send money.</p></div></div>
        {payouts.length === 0 ? <p className="text-sm text-[#6E6E73]">No payout batches recorded yet.</p> : <div className="space-y-2">{payouts.slice(0, 5).map(payout => <div key={payout.id} className="flex items-center justify-between border-b border-black/5 pb-2 text-sm"><span className="capitalize">{payout.range} · {payout.employeeCount} employees</span><span className="font-medium">{fmtMoney(payout.totalKES, 'KES')} · recorded</span></div>)}</div>}
      </Card>

      <Card className="p-6">
        <h2 className="font-semibold mb-4">Expenses</h2>
        {expenses.length === 0 ? <EmptyState icon={Receipt} title="No expenses recorded" description="Track rent, supplies and other operating costs here." /> : (
          <ul className="divide-y divide-black/5">
            {[...expenses].sort((a, b) => b.date.localeCompare(a.date)).map(e => (
              <li key={e.id} className="py-3 flex items-center justify-between text-sm">
                <div><p className="font-medium">{e.category}</p><p className="text-xs text-[#6E6E73]">{e.note} · {e.date}</p></div>
                <Badge tone="neutral">{fmtMoney(e.amount, 'KES')}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {open && (
        <Modal title="Record Expense" onClose={() => setOpen(false)} footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={addExpense}>Save Expense</Button>
        </>}>
          <div className="space-y-4">
            <Field label="Category" htmlFor="e-cat">
              <Select id="e-cat" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                <option>Rent</option><option>Utilities</option><option>Supplies</option><option>Salaries</option><option>Marketing</option><option>Other</option>
              </Select>
            </Field>
            <Field label="Amount (KES)" htmlFor="e-amount"><Input id="e-amount" type="number" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: Number(e.target.value) }))} /></Field>
            <Field label="Note" htmlFor="e-note"><Input id="e-note" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} /></Field>
            <Field label="Date" htmlFor="e-date"><Input id="e-date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Finance;
