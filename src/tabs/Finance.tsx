import { useEffect, useState } from 'react';
import { Download, Plus, Receipt, Search } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, EmptyState, LoadingState, StatCard, toast } from '../components/ui';
import { AppointmentsApi, DashboardApi, downloadCSV, ExpensesApi, PayrollApi, PayoutsApi, fmtMoney } from '../lib/api';
import type { DashboardData, Expense, PayoutBatch, Staff, WeeklyStaffWorkReport } from '../types';

type Range = 'today' | 'week' | 'month' | 'all';

function Finance() {
  const [range, setRange] = useState<Range>('month');
  const [data, setData] = useState<DashboardData | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [payouts, setPayouts] = useState<PayoutBatch[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [payrollPeriod, setPayrollPeriod] = useState<{ from: number; to: number } | null>(null);
  const [payrollLoading, setPayrollLoading] = useState(true);
  const [payrollError, setPayrollError] = useState('');
  const [financeDataError, setFinanceDataError] = useState('');
  const [payrollSending, setPayrollSending] = useState(false);
  const [deletingEarnings, setDeletingEarnings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [earningsDeleteOpen, setEarningsDeleteOpen] = useState(false);
  const [earningsDeleteRange, setEarningsDeleteRange] = useState({ from: '', to: '' });
  const [form, setForm] = useState({ category: 'Supplies', amount: 0, note: '', date: new Date().toISOString().slice(0, 10) });
  const [breakdownStaff, setBreakdownStaff] = useState<Staff | null>(null);
  const [breakdown, setBreakdown] = useState<WeeklyStaffWorkReport | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState('');

  const loadPayroll = () => {
    setPayrollLoading(true);
    setPayrollError('');
    PayrollApi.staff()
      .then(payroll => { setStaff(payroll.items); setPayrollPeriod(payroll.period); })
      .catch((cause: any) => setPayrollError(cause?.message || 'Could not load this week’s payroll data.'))
      .finally(() => setPayrollLoading(false));
  };
  const load = () => {
    setLoading(true);
    setFinanceDataError('');
    DashboardApi.get(range)
      .then(setData)
      .catch((cause: any) => setFinanceDataError(cause?.message || 'Finance metrics are temporarily unavailable.'))
      .finally(() => setLoading(false));
    ExpensesApi.list().then(setExpenses).catch(() => undefined);
    PayoutsApi.list().then(setPayouts).catch(() => undefined);
    loadPayroll();
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

  const revenueKES = data?.revenueByCurrency.KES || 0;
  const staffEarningsKES = data?.commissionsByCurrency.KES || 0;
  const profitKES = data?.estimatedProfitByCurrency.KES || 0;
  const payrollDateRange = payrollPeriod
    ? `${new Date(payrollPeriod.from).toLocaleDateString()} – ${new Date(payrollPeriod.to).toLocaleDateString()}`
    : 'Sunday–Saturday';
  const payrollStaff = staff.filter(member => member.employmentStatus !== 'laid-off');
  const openBreakdown = async (member: Staff) => {
    setBreakdownStaff(member);
    setBreakdown(null);
    setBreakdownError('');
    setBreakdownLoading(true);
    try { setBreakdown(await AppointmentsApi.staffWeeklyWork(member.id)); }
    catch (cause: any) { setBreakdownError(cause?.message || 'Could not load this staff member’s appointment earnings.'); }
    finally { setBreakdownLoading(false); }
  };
  const closeBreakdown = () => { setBreakdownStaff(null); setBreakdown(null); setBreakdownError(''); };
  const breakdownLines = breakdown?.services.flatMap(service => service.distribution
    .filter(line => line.staffId === breakdownStaff?.id)
    .map(line => ({ service, line }))) || [];
  const breakdownCommission = breakdownLines.filter(({ line }) => line.role !== 'assistant').reduce((sum, item) => sum + item.line.amount, 0);
  const breakdownAssistant = breakdownLines.filter(({ line }) => line.role === 'assistant').reduce((sum, item) => sum + item.line.amount, 0);
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
          <Button variant="danger" onClick={() => setEarningsDeleteOpen(true)}>Clear paid earnings</Button>
        </div>
      </div>

      {!data && loading && <LoadingState label="Loading finance metrics…" />}
      {!data && !loading && financeDataError && <Card className="p-5"><p role="status" className="text-sm text-amber-700">{financeDataError}</p></Card>}
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
                  <thead><tr className="text-left text-xs text-[#6E6E73] border-b border-black/5"><th className="pb-2 pr-3">Staff</th><th className="pb-2 pr-3">Services</th><th className="pb-2 pr-3">Service revenue</th><th className="pb-2 pr-3">Assistant fees deducted</th><th className="pb-2 pr-3">Commission</th><th className="pb-2 pr-3">Assistant earnings</th><th className="pb-2 pr-3">Total earnings</th><th className="pb-2">Breakdown</th></tr></thead>
                  <tbody>
                    {data.staffEarnings.map(member => (
                      <tr key={`${member.staffId}-${member.currency}`} className="border-b border-black/5 last:border-0">
                        <td className="py-2 pr-3">{member.name}</td><td className="py-2 pr-3">{member.count}</td><td className="py-2 pr-3">{fmtMoney(member.revenue, member.currency)}</td><td className="py-2 pr-3">{fmtMoney(member.helperDeductions, member.currency)}</td><td className="py-2 pr-3">{fmtMoney(member.commission, member.currency)}</td><td className="py-2 pr-3">{fmtMoney(member.assistantEarnings, member.currency)}</td><td className="py-2 pr-3 font-medium">{fmtMoney(member.commission + member.assistantEarnings, member.currency)}</td><td className="py-2"><Button size="sm" variant="secondary" onClick={() => openBreakdown(staff.find(item => item.id === member.staffId) || { id: member.staffId, name: member.name } as Staff)}><Search size={14} aria-hidden="true" />Open</Button></td>
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
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4"><div><h2 className="font-semibold">Payroll</h2><p className="text-xs text-[#6E6E73]">Unpaid commissions and assistant earnings from {payrollDateRange}.</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={downloadPayroll} disabled={payrollLoading || !payrollStaff.length}><Download size={16} aria-hidden="true" />Download payroll CSV</Button><Button variant="secondary" onClick={loadPayroll} disabled={payrollLoading}>{payrollLoading ? 'Refreshing…' : 'Refresh payroll'}</Button><Button onClick={sendPayroll} disabled={payrollSending || payrollLoading}>{payrollSending ? 'Sending…' : 'Send payroll batch'}</Button></div></div>
        {payrollLoading ? <p className="text-sm text-[#6E6E73]">Loading staff payroll…</p> : payrollError ? <p role="alert" className="text-sm text-amber-700">{payrollError} Use “Refresh payroll” to try again.</p> : payrollStaff.length === 0 ? <p className="text-sm text-[#6E6E73]">No active staff records were returned for payroll.</p> : <div className="space-y-2">{payrollStaff.map(member => { const commission = member.commissionEarnedWeek || 0; const assistant = member.assistantEarnedWeek || 0; const calculated = commission + assistant; return <div key={member.id} className="flex items-center justify-between gap-3 border-b border-black/5 pb-2"><div><p className="text-sm font-medium">{member.name}</p><p className="text-xs text-[#6E6E73]">{member.phone || 'No phone number'} · {member.branchName || member.branch}</p><p className="text-xs text-[#6E6E73]">Commission {fmtMoney(commission, 'KES')} + assistant compensation {fmtMoney(assistant, 'KES')}</p></div><p className="font-semibold text-sm">{fmtMoney(calculated, 'KES')}</p></div>; })}</div>}
      </Card>

      {breakdownStaff && <Modal title={`${breakdownStaff.name} appointment earnings`} onClose={closeBreakdown} footer={<Button variant="secondary" onClick={closeBreakdown}>Close</Button>}>
        <div className="space-y-4">
          <p className="text-sm text-[#6E6E73]">Completed appointments linked to this staff member for {payrollDateRange}. Amounts come from recorded service commissions and assistant compensation.</p>
          {breakdownLoading ? <LoadingState label="Loading appointment earnings…" /> : breakdownError ? <p role="alert" className="text-sm text-amber-700">{breakdownError}</p> : !breakdownLines.length ? <p className="text-sm text-[#6E6E73]">No completed appointment earnings were found.</p> : <>
            <div className="grid grid-cols-3 gap-3"><div className="rounded-xl bg-black/[0.03] p-3"><p className="text-xs text-[#6E6E73]">Appointments</p><p className="text-lg font-semibold">{breakdownLines.length}</p></div><div className="rounded-xl bg-black/[0.03] p-3"><p className="text-xs text-[#6E6E73]">Commission</p><p className="text-lg font-semibold">{fmtMoney(breakdownCommission, 'KES')}</p></div><div className="rounded-xl bg-black/[0.03] p-3"><p className="text-xs text-[#6E6E73]">Assistant</p><p className="text-lg font-semibold">{fmtMoney(breakdownAssistant, 'KES')}</p></div></div>
            <div className="max-h-[55vh] overflow-y-auto divide-y divide-black/5">{breakdownLines.map(({ service, line }, index) => <div key={`${service.orderId}-${line.itemKey}-${index}`} className="py-3"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium">{service.serviceName} · {service.customerName}</p><p className="text-xs text-[#6E6E73]">{service.appointmentDate || 'No appointment date'}{service.appointmentTime ? ` at ${service.appointmentTime}` : ''} · {line.role.replace('-', ' ')} · {service.appointmentStatus || 'completed'}</p></div><p className="shrink-0 text-sm font-semibold">{fmtMoney(line.amount, 'KES')}</p></div><p className="mt-1 text-xs text-[#6E6E73]">Revenue {fmtMoney(service.serviceRevenue, 'KES')} · commission base {fmtMoney(service.commissionBase, 'KES')} · order {service.orderId.slice(0, 8)}</p></div>)}</div>
          </>}
        </div>
      </Modal>}

      {earningsDeleteOpen && <Modal title="Clear paid staff earnings" onClose={() => setEarningsDeleteOpen(false)} footer={<><Button variant="secondary" onClick={() => setEarningsDeleteOpen(false)}>Cancel</Button><Button variant="danger" onClick={deletePaidEarnings} disabled={deletingEarnings}>{deletingEarnings ? 'Clearing…' : 'Clear earnings'}</Button></>}>
        <div className="space-y-4">
          <p className="text-sm text-[#6E6E73]">Choose the order dates whose paid earning lines should disappear from staff dashboards and payroll. Orders and payout history remain for audit.</p>
          <div className="grid sm:grid-cols-2 gap-4"><Field label="From" htmlFor="earnings-delete-from"><Input id="earnings-delete-from" type="date" value={earningsDeleteRange.from} onChange={event => setEarningsDeleteRange(current => ({ ...current, from: event.target.value }))} /></Field><Field label="To" htmlFor="earnings-delete-to"><Input id="earnings-delete-to" type="date" value={earningsDeleteRange.to} onChange={event => setEarningsDeleteRange(current => ({ ...current, to: event.target.value }))} /></Field></div>
        </div>
      </Modal>}

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4"><div><h2 className="font-semibold">Payout audit history</h2><p className="text-xs text-[#6E6E73]">Historical internal markers are shown for audit. Markers are not money transfers and no longer reduce outstanding earnings.</p></div></div>
        {payouts.length === 0 ? <p className="text-sm text-[#6E6E73]">No payout audit records yet.</p> : <div className="space-y-2">{payouts.slice(0, 5).map(payout => <div key={payout.id} className="flex items-center justify-between border-b border-black/5 pb-2 text-sm"><span className="capitalize">{payout.range} · {payout.employeeCount} employees</span><span className={`font-medium ${payout.status === 'reversed' ? 'text-amber-700' : ''}`}>{fmtMoney(payout.totalKES, 'KES')} · {payout.status === 'reversed' ? 'reversed' : 'legacy marker'}</span></div>)}</div>}
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
