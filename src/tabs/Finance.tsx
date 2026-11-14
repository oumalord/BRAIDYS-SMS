import { useEffect, useState } from 'react';
import { CalendarDays, Download, Plus, Receipt, Search, Users } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, EmptyState, LoadingState, StatCard, toast } from '../components/ui';
import { AppointmentsApi, AuthApi, DashboardApi, downloadCSV, ExpensesApi, PayrollApi, PayoutsApi, fmtMoney } from '../lib/api';
import type { DashboardData, Expense, PayoutBatch, PaystackPayrollBatch, Staff, WeeklyStaffWorkReport } from '../types';

type Range = 'today' | 'week' | 'month' | 'all';
type FinanceView = 'overview' | 'daily';

function todayInNairobi() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find(value => value.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function Finance() {
  const isOwner = AuthApi.account()?.role === 'owner';
  const [range, setRange] = useState<Range>('week');
  const [financeView, setFinanceView] = useState<FinanceView>('overview');
  const [dailyDate, setDailyDate] = useState(todayInNairobi);
  const [dailyData, setDailyData] = useState<DashboardData | null>(null);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState('');
  const [data, setData] = useState<DashboardData | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [payouts, setPayouts] = useState<PayoutBatch[]>([]);
  const [paystackBatches, setPaystackBatches] = useState<PaystackPayrollBatch[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [payrollPeriod, setPayrollPeriod] = useState<{ from: number; to: number } | null>(null);
  const [lastWeekStaff, setLastWeekStaff] = useState<Staff[]>([]);
  const [lastWeekPeriod, setLastWeekPeriod] = useState<{ from: number; to: number } | null>(null);
  const [lastWeekLoading, setLastWeekLoading] = useState(true);
  const [lastWeekError, setLastWeekError] = useState('');
  const [payrollLoading, setPayrollLoading] = useState(true);
  const [payrollError, setPayrollError] = useState('');
  const [paystackConfigured, setPaystackConfigured] = useState(false);
  const [canSendPaystack, setCanSendPaystack] = useState(false);
  const [financeDataError, setFinanceDataError] = useState('');
  const [payrollSending, setPayrollSending] = useState(false);
  const [recipientsSyncing, setRecipientsSyncing] = useState(false);
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
    setLastWeekLoading(true);
    setLastWeekError('');
    PayrollApi.staff('last-week')
      .then(payroll => { setLastWeekStaff(payroll.items); setLastWeekPeriod(payroll.period); })
      .catch((cause: any) => setLastWeekError(cause?.message || 'Could not load last week’s unpaid earnings.'))
      .finally(() => setLastWeekLoading(false));
    PayrollApi.paystackStatus().then(status => { setPaystackConfigured(status.configured); setCanSendPaystack(status.canSend); }).catch(() => { setPaystackConfigured(false); setCanSendPaystack(false); });
  };
  const load = (refreshPayroll = true) => {
    setLoading(true);
    setFinanceDataError('');
    DashboardApi.get(range)
      .then(setData)
      .catch((cause: any) => setFinanceDataError(cause?.message || 'Finance metrics are temporarily unavailable.'))
      .finally(() => setLoading(false));
    ExpensesApi.list().then(setExpenses).catch(() => undefined);
    PayoutsApi.list().then(setPayouts).catch(() => undefined);
    PayrollApi.paystackBatches().then(setPaystackBatches).catch(() => undefined);
    if (refreshPayroll) loadPayroll();
  };
  useEffect(() => {
    load();
    const refresh = window.setInterval(() => load(false), 15000);
    return () => window.clearInterval(refresh);
  }, [range]);

  useEffect(() => {
    if (!isOwner || financeView !== 'daily') return;
    let active = true;
    const loadSelectedDay = () => {
      setDailyLoading(true);
      setDailyError('');
      DashboardApi.getDay(dailyDate)
        .then(result => { if (active) setDailyData(result); })
        .catch((cause: any) => { if (active) setDailyError(cause?.message || 'Could not load this day’s finance summary.'); })
        .finally(() => { if (active) setDailyLoading(false); });
    };
    setDailyData(null);
    loadSelectedDay();
    const refresh = window.setInterval(loadSelectedDay, 15000);
    return () => { active = false; window.clearInterval(refresh); };
  }, [isOwner, financeView, dailyDate]);

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

  const sendPaystackPayroll = async () => {
    const recipients = paystackRecipients;
    if (!recipients.length) { toast('No unpaid KES earnings are available to transfer.', 'error'); return; }
    const totalKES = recipients.reduce((sum, item) => sum + item.amountKES, 0);
    if (!window.confirm(`Submit ${fmtMoney(totalKES, 'KES')} for ${recipients.length} staff member${recipients.length === 1 ? '' : 's'} to Paystack for last week (${lastWeekDateRange})? Earnings will be marked paid only after Paystack confirms each transfer.`)) return;
    setPayrollSending(true);
    try {
      const response = await PayrollApi.sendPaystack(recipients.map(({ member }) => member.id), Object.fromEntries(recipients.map(({ member, amountKES }) => [member.id, amountKES])));
      const result = response.data;
      toast(`Paystack accepted ${result.pendingCount + result.successCount}/${result.employeeCount} transfers. Only confirmed transfers are marked paid.`, 'success');
      loadPayroll();
      PayrollApi.paystackBatches().then(setPaystackBatches).catch(() => undefined);
    } catch (cause: any) {
      toast(cause?.message || 'Paystack payroll transfer failed.', 'error');
    } finally {
      setPayrollSending(false);
    }
  };

  const syncPaystackRecipients = async () => {
    if (!window.confirm('Create Paystack M-PESA recipients for eligible staff, excluding receptionists and administrators? This will not send payments.')) return;
    setRecipientsSyncing(true);
    try {
      const { data } = await PayrollApi.syncPaystackRecipients();
      const firstFailure = data.failures?.[0];
      const summary = `${data.createdCount} created, ${data.existingCount} already ready, ${data.failedCount} failed.`;
      toast(firstFailure ? `${summary} ${firstFailure.name}: ${firstFailure.error}` : `${summary} No payments were sent.`, firstFailure ? 'error' : 'success');
      loadPayroll();
    } catch (cause: any) {
      toast(cause?.message || 'Could not sync Paystack recipients.', 'error');
    } finally {
      setRecipientsSyncing(false);
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
  const payrollDateFormatter = new Intl.DateTimeFormat(undefined, { timeZone: 'Africa/Nairobi' });
  const payrollDateRange = payrollPeriod
    ? `${payrollDateFormatter.format(new Date(payrollPeriod.from))} – ${payrollDateFormatter.format(new Date(payrollPeriod.to))}`
    : 'Saturday through Friday';
  const lastWeekDateRange = lastWeekPeriod
    ? `${payrollDateFormatter.format(new Date(lastWeekPeriod.from))} – ${payrollDateFormatter.format(new Date(lastWeekPeriod.to))}`
    : 'previous Saturday through Friday';
  const selectedEarningsLabel = lastWeekDateRange;
  const totalUnpaidEarnings = (member: Staff) => Number(member.commissionEarnedWeek || 0) + Number(member.assistantEarnedWeek || 0);
  const payrollStaff = staff.filter(member => member.employmentStatus !== 'laid-off')
    .sort((first, second) => totalUnpaidEarnings(second) - totalUnpaidEarnings(first) || first.name.localeCompare(second.name));
  const lastWeekPayrollStaff = lastWeekStaff.filter(member => member.employmentStatus !== 'laid-off');
  const paystackRecipients = lastWeekPayrollStaff.map(member => ({ member, amountKES: Math.round(totalUnpaidEarnings(member)) })).filter(item => item.amountKES > 0);
  const paystackRecipientsMissingCount = paystackRecipients.filter(({ member }) => member.paystackRecipientMode !== 'live'
    || !/^RCP_[A-Za-z0-9]+$/.test(String(member.paystackRecipientCode || ''))).length;
  const paystackDepositTotalKES = paystackRecipients.reduce((sum, recipient) => sum + recipient.amountKES, 0);
  const weeklyStaffEarnings = lastWeekPayrollStaff.map(member => {
    const commission = Number(member.commissionEarnedWeek || 0);
    const assistantEarnings = Number(member.assistantEarnedWeek || 0);
    return {
      member,
      count: member.unpaidEarningCount || 0,
      revenue: member.unpaidServiceRevenueKES || 0,
      helperDeductions: member.unpaidAssistantFeesKES || 0,
      commission,
      assistantEarnings,
    };
  }).sort((first, second) => second.commission + second.assistantEarnings - first.commission - first.assistantEarnings
    || first.member.name.localeCompare(second.member.name));
  const openBreakdown = async (member: Staff) => {
    setBreakdownStaff(member);
    setBreakdown(null);
    setBreakdownError('');
    setBreakdownLoading(true);
    try { setBreakdown(await AppointmentsApi.staffWeeklyWork(member.id, undefined, 'last-week')); }
    catch (cause: any) { setBreakdownError(cause?.message || 'Could not load this staff member’s appointment earnings.'); }
    finally { setBreakdownLoading(false); }
  };
  const closeBreakdown = () => { setBreakdownStaff(null); setBreakdown(null); setBreakdownError(''); };
  const breakdownLines = breakdown?.services.flatMap(service => service.distribution
    .filter(line => line.staffId === breakdownStaff?.id)
    .map(line => ({ service, line }))) || [];
  const breakdownCommission = breakdownLines.filter(({ line }) => line.role !== 'assistant').reduce((sum, item) => sum + item.line.amount, 0);
  const breakdownAssistant = breakdownLines.filter(({ line }) => line.role === 'assistant').reduce((sum, item) => sum + item.line.amount, 0);
  const dailyTotals = weeklyStaffEarnings.reduce((totals, row) => ({
    count: totals.count + row.count,
    revenue: totals.revenue + row.revenue,
    helperDeductions: totals.helperDeductions + row.helperDeductions,
    commission: totals.commission + row.commission,
    assistantEarnings: totals.assistantEarnings + row.assistantEarnings,
    totalEarnings: totals.totalEarnings + Math.round(row.commission + row.assistantEarnings),
  }), { count: 0, revenue: 0, helperDeductions: 0, commission: 0, assistantEarnings: 0, totalEarnings: 0 });
  const dailyStaffRows = (dailyData?.staffEarnings || []).filter(row => row.currency === 'KES')
    .sort((first, second) => first.name.localeCompare(second.name));
  const dailyCommissionTotal = dailyStaffRows.reduce((sum, row) => sum + row.commission, 0);
  const dailyAssistantTotal = dailyStaffRows.reduce((sum, row) => sum + row.assistantEarnings, 0);
  const dailyStaffPaymentTotal = dailyCommissionTotal + dailyAssistantTotal;
  const dailyDateLabel = new Intl.DateTimeFormat(undefined, {
    timeZone: 'Africa/Nairobi', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(`${dailyDate}T12:00:00+03:00`));
  const downloadPayroll = () => {
    const startDate = payrollPeriod ? new Date(payrollPeriod.from) : new Date();
    const endDate = payrollPeriod ? new Date(payrollPeriod.to) : new Date();
    const dateKey = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const totalCommission = payrollStaff.reduce((sum, member) => sum + (member.commissionEarnedWeek || 0), 0);
    const totalAssistant = payrollStaff.reduce((sum, member) => sum + (member.assistantEarnedWeek || 0), 0);
    const totalPayable = payrollStaff.reduce((sum, member) => sum + Math.round((member.commissionEarnedWeek || 0) + (member.assistantEarnedWeek || 0)), 0);
    const rows: (string | number)[][] = [
      ['BRAIDY SALON weekly payroll'],
      ['Earnings period', payrollDateRange],
      ['Generated', new Date().toLocaleString()],
      [],
      ['Staff ID', 'Staff name', 'Role', 'Phone', 'Branch', 'Commission (KES)', 'Assistant earnings (KES)', 'Total earnings (KES)'],
      ...payrollStaff.map(member => {
        const commission = member.commissionEarnedWeek || 0;
        const assistant = member.assistantEarnedWeek || 0;
        return [member.id, member.name, member.role, member.phone || '', member.branchName || member.branch || '', commission, assistant, Math.round(commission + assistant)];
      }),
      [],
      ['TOTAL', '', '', '', '', totalCommission, totalAssistant, totalPayable],
    ];
    downloadCSV(`braidy-salon-payroll-${dateKey(startDate)}-to-${dateKey(endDate)}.csv`, rows);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">Finance</h1><p className="text-sm text-[#6E6E73]">Revenue, commissions, expenses and profitability, computed from real transactions.</p></div>
        <div className="flex items-center gap-2">
          {financeView === 'overview' && <Select aria-label="Date range" value={range} onChange={e => setRange(e.target.value as Range)} className="w-auto" style={{ width: 'auto' }}>
            <option value="today">Today</option><option value="week">This Week</option><option value="month">This Month</option><option value="all">All Time</option>
          </Select>}
          <Button variant="secondary" onClick={sendPaystackPayroll} disabled={payrollSending || payrollLoading || lastWeekLoading || Boolean(lastWeekError) || !paystackConfigured || !canSendPaystack || !paystackRecipients.length || paystackRecipientsMissingCount > 0} title={paystackConfigured ? 'Submit last week’s unpaid staff earnings through Paystack' : 'Configure Paystack to enable payroll transfers'}><Receipt size={16} aria-hidden="true" />Pay last week</Button>
          <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />Add Expense</Button>
          <Button variant="danger" onClick={() => setEarningsDeleteOpen(true)}>Clear paid earnings</Button>
        </div>
      </div>

      {isOwner && <div role="tablist" aria-label="Finance views" className="flex w-fit rounded-xl border border-black/10 bg-white p-1">
        <button type="button" role="tab" aria-selected={financeView === 'overview'} onClick={() => setFinanceView('overview')}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${financeView === 'overview' ? 'bg-[#2F6BFF] text-white' : 'text-[#6E6E73] hover:bg-black/[0.04]'}`}>Overview</button>
        <button type="button" role="tab" aria-selected={financeView === 'daily'} onClick={() => setFinanceView('daily')}
          className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${financeView === 'daily' ? 'bg-[#2F6BFF] text-white' : 'text-[#6E6E73] hover:bg-black/[0.04]'}`}><CalendarDays size={16} aria-hidden="true" />Single day</button>
      </div>}

      {isOwner && financeView === 'daily' && <div className="space-y-5">
        <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-end sm:justify-between">
          <div><h2 className="font-semibold">Daily financial summary</h2><p className="mt-1 text-sm text-[#6E6E73]">Revenue, staff pay, and net profit for {dailyDateLabel}.</p></div>
          <Field label="Business date" htmlFor="finance-daily-date"><Input id="finance-daily-date" type="date" value={dailyDate} onChange={event => setDailyDate(event.target.value)} /></Field>
        </Card>
        {dailyLoading && !dailyData && <LoadingState label="Loading daily finance summary…" />}
        {dailyError && <Card className="p-5"><p role="alert" className="text-sm text-amber-700">{dailyError}</p></Card>}
        {dailyData && <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Total revenue" value={fmtMoney(dailyData.revenueByCurrency.KES || 0, 'KES')} icon={Receipt} tone="success" />
            <StatCard label="Staff payment total" value={fmtMoney(dailyStaffPaymentTotal, 'KES')} sub={`${fmtMoney(dailyCommissionTotal, 'KES')} commission · ${fmtMoney(dailyAssistantTotal, 'KES')} assistant`} icon={Users} />
            <StatCard label="Net profit" value={fmtMoney(dailyData.estimatedProfitByCurrency.KES || 0, 'KES')} icon={Receipt} tone={(dailyData.estimatedProfitByCurrency.KES || 0) >= 0 ? 'success' : 'danger'} />
          </div>
          <Card className="p-5">
            <div className="mb-3"><h2 className="font-semibold">Staff payments</h2><p className="text-xs text-[#6E6E73]">All staff for {dailyDateLabel}, including zero-payment staff.</p></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-black/5 text-left text-xs text-[#6E6E73]"><th className="pb-2 pr-3">Staff</th><th className="pb-2 pr-3">Commission</th><th className="pb-2 pr-3">Assistant compensation</th><th className="pb-2">Total payment</th></tr></thead>
                <tbody>{dailyStaffRows.map(row => <tr key={row.staffId} className="border-b border-black/5 last:border-0"><td className="py-2 pr-3">{row.name}</td><td className="py-2 pr-3">{fmtMoney(row.commission, 'KES')}</td><td className="py-2 pr-3">{fmtMoney(row.assistantEarnings, 'KES')}</td><td className="py-2 font-medium">{fmtMoney(row.commission + row.assistantEarnings, 'KES')}</td></tr>)}</tbody>
                <tfoot><tr className="border-t-2 border-black/10 font-semibold"><td className="pt-3 pr-3">TOTAL</td><td className="pt-3 pr-3">{fmtMoney(dailyCommissionTotal, 'KES')}</td><td className="pt-3 pr-3">{fmtMoney(dailyAssistantTotal, 'KES')}</td><td className="pt-3">{fmtMoney(dailyStaffPaymentTotal, 'KES')}</td></tr></tfoot>
              </table>
            </div>
          </Card>
        </>}
      </div>}

      {financeView === 'overview' && !data && loading && <LoadingState label="Loading finance metrics…" />}
      {financeView === 'overview' && !data && !loading && financeDataError && <Card className="p-5"><p role="status" className="text-sm text-amber-700">{financeDataError}</p></Card>}
      {financeView === 'overview' && data && (
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
            <div className="mb-3"><h2 className="font-semibold mb-1">Last Week’s Unpaid Staff Earnings</h2><p className="text-xs text-[#6E6E73]">Unpaid KES commissions and assistant compensation for {selectedEarningsLabel}. Already-paid earnings are excluded.</p></div>
            {lastWeekLoading ? <p className="text-sm text-[#6E6E73]">Loading last week’s unpaid earnings…</p> : lastWeekError ? <p role="status" className="text-sm text-amber-700">{lastWeekError}</p> : weeklyStaffEarnings.length === 0 ? <p className="text-sm text-[#6E6E73]">No staff records are available.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">Commission and assistant earnings by staff for {selectedEarningsLabel}</caption>
                  <thead><tr className="text-left text-xs text-[#6E6E73] border-b border-black/5"><th className="pb-2 pr-3">Staff</th><th className="pb-2 pr-3">Earning lines</th><th className="pb-2 pr-3">Service revenue</th><th className="pb-2 pr-3">Assistant fees deducted</th><th className="pb-2 pr-3">Commission</th><th className="pb-2 pr-3">Assistant earnings</th><th className="pb-2 pr-3">Total earnings</th><th className="pb-2">Breakdown</th></tr></thead>
                  <tbody>
                    {weeklyStaffEarnings.map(({ member, count, revenue, helperDeductions, commission, assistantEarnings }) => (
                      <tr key={member.id} className="border-b border-black/5 last:border-0">
                        <td className="py-2 pr-3">{member.name}</td><td className="py-2 pr-3">{count}</td><td className="py-2 pr-3">{fmtMoney(revenue, 'KES')}</td><td className="py-2 pr-3">{fmtMoney(helperDeductions, 'KES')}</td><td className="py-2 pr-3">{fmtMoney(commission, 'KES')}</td><td className="py-2 pr-3">{fmtMoney(assistantEarnings, 'KES')}</td><td className="py-2 pr-3 font-medium">{fmtMoney(commission + assistantEarnings, 'KES')}</td><td className="py-2"><Button size="sm" variant="secondary" onClick={() => openBreakdown(member)}><Search size={14} aria-hidden="true" />Open</Button></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="border-t-2 border-black/10 font-semibold"><td className="py-3 pr-3">TOTAL</td><td className="py-3 pr-3">{dailyTotals.count}</td><td className="py-3 pr-3">{fmtMoney(dailyTotals.revenue, 'KES')}</td><td className="py-3 pr-3">{fmtMoney(dailyTotals.helperDeductions, 'KES')}</td><td className="py-3 pr-3">{fmtMoney(dailyTotals.commission, 'KES')}</td><td className="py-3 pr-3">{fmtMoney(dailyTotals.assistantEarnings, 'KES')}</td><td className="py-3 pr-3">{fmtMoney(dailyTotals.totalEarnings, 'KES')}</td><td /></tr></tfoot>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4"><div><h2 className="font-semibold">Unpaid payroll</h2><p className="text-xs text-[#6E6E73]">Current Saturday-to-Friday period: {payrollDateRange}. Earnings are counted only once an appointment is completed.</p></div><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={downloadPayroll} disabled={payrollLoading || !payrollStaff.length}><Download size={16} aria-hidden="true" />Download payroll CSV</Button><Button variant="secondary" onClick={loadPayroll} disabled={payrollLoading}>{payrollLoading ? 'Refreshing…' : 'Refresh payroll'}</Button><Button variant="secondary" onClick={sendPayroll} disabled={payrollSending || payrollLoading}>{payrollSending ? 'Sending…' : 'Send M-Pesa batch'}</Button>{paystackConfigured && canSendPaystack && <><Button variant="secondary" onClick={syncPaystackRecipients} disabled={recipientsSyncing || payrollSending || payrollLoading}><Users size={16} aria-hidden="true" />{recipientsSyncing ? 'Syncing…' : 'Sync recipients'}</Button><Button onClick={sendPaystackPayroll} disabled={payrollSending || payrollLoading || lastWeekLoading || recipientsSyncing || !paystackRecipients.length || paystackRecipientsMissingCount > 0}>{payrollSending ? 'Submitting…' : 'Pay last week with Paystack'}</Button></>}</div></div>
        {paystackConfigured ? <p className="mb-3 text-xs text-[#6E6E73]">Live Paystack KES transfers are configured. Sync recipients before sending; each click submits one bulk transfer request to their registered M-PESA numbers.</p> : <p className="mb-3 text-xs text-[#6E6E73]">Paystack payroll requires a live secret key in the backend environment.</p>}
        {paystackConfigured && paystackRecipientsMissingCount > 0 && <p role="status" className="mb-3 text-xs text-amber-700">{paystackRecipientsMissingCount} staff recipient{paystackRecipientsMissingCount === 1 ? '' : 's'} need syncing before Paystack can send.</p>}
        {!lastWeekLoading && !lastWeekError && <div className="my-4 flex flex-col gap-1 border-y border-black/10 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-semibold">Paystack deposit needed</p><p className="text-xs text-[#6E6E73]">Unpaid KES earnings from last week ({lastWeekDateRange}) for {paystackRecipients.length} staff member{paystackRecipients.length === 1 ? '' : 's'}, rounded per person.</p></div><p className="text-lg font-semibold">{fmtMoney(paystackDepositTotalKES, 'KES')}</p></div>}
        {payrollLoading ? <p className="text-sm text-[#6E6E73]">Loading staff payroll…</p> : payrollError ? <p role="alert" className="text-sm text-amber-700">{payrollError} Use “Refresh payroll” to try again.</p> : payrollStaff.length === 0 ? <p className="text-sm text-[#6E6E73]">No active staff records were returned for payroll.</p> : <div className="space-y-2">{payrollStaff.map(member => { const commission = member.commissionEarnedWeek || 0; const assistant = member.assistantEarnedWeek || 0; const calculated = Math.round(commission + assistant); return <div key={member.id} className="flex items-center justify-between gap-3 border-b border-black/5 pb-2"><div><p className="text-sm font-medium">{member.name}</p><p className="text-xs text-[#6E6E73]">{member.phone || 'No phone number'} · {member.branchName || member.branch}</p><p className="text-xs text-[#6E6E73]">Commission {fmtMoney(commission, 'KES')} + assistant compensation {fmtMoney(assistant, 'KES')}</p></div><p className="font-semibold text-sm">{fmtMoney(calculated, 'KES')}</p></div>; })}</div>}
      </Card>

      {breakdownStaff && <Modal title={`${breakdownStaff.name} unpaid earnings`} onClose={closeBreakdown} footer={<Button variant="secondary" onClick={closeBreakdown}>Close</Button>}>
        <div className="space-y-4">
          <p className="text-sm text-[#6E6E73]">Unpaid KES earnings from completed appointments for {selectedEarningsLabel}. Already-paid earnings are excluded.</p>
          {breakdownLoading ? <LoadingState label="Loading unpaid earnings…" /> : breakdownError ? <p role="alert" className="text-sm text-amber-700">{breakdownError}</p> : !breakdownLines.length ? <p className="text-sm text-[#6E6E73]">No unpaid earnings were found in this period.</p> : <>
            <div className="grid grid-cols-3 gap-3"><div className="rounded-xl bg-black/[0.03] p-3"><p className="text-xs text-[#6E6E73]">Appointments</p><p className="text-lg font-semibold">{breakdownLines.length}</p></div><div className="rounded-xl bg-black/[0.03] p-3"><p className="text-xs text-[#6E6E73]">Commission</p><p className="text-lg font-semibold">{fmtMoney(breakdownCommission, 'KES')}</p></div><div className="rounded-xl bg-black/[0.03] p-3"><p className="text-xs text-[#6E6E73]">Assistant</p><p className="text-lg font-semibold">{fmtMoney(breakdownAssistant, 'KES')}</p></div></div>
            <div className="max-h-[55vh] overflow-y-auto divide-y divide-black/5">{breakdownLines.map(({ service, line }, index) => <div key={`${service.orderId}-${line.itemKey}-${index}`} className="py-3"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium">{service.serviceName} · {service.customerName}</p><p className="text-xs text-[#6E6E73]">{service.appointmentDate || 'No appointment date'}{service.appointmentTime ? ` at ${service.appointmentTime}` : ''}{service.cardNumber ? ` · Card ${service.cardNumber}` : ''} · {line.role.replace('-', ' ')} · {service.appointmentStatus || 'completed'}</p></div><p className="shrink-0 text-sm font-semibold">{fmtMoney(line.amount, 'KES')}</p></div><p className="mt-1 text-xs text-[#6E6E73]">Revenue {fmtMoney(service.serviceRevenue, 'KES')} · commission base {fmtMoney(service.commissionBase, 'KES')} · order {service.orderId.slice(0, 8)}</p></div>)}</div>
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
        <h2 className="font-semibold mb-1">Paystack transfer batches</h2><p className="text-xs text-[#6E6E73] mb-4">Transfers are marked paid only after signed Paystack webhook confirmation.</p>
        {paystackBatches.length === 0 ? <p className="text-sm text-[#6E6E73]">No Paystack batches submitted yet.</p> : <div className="space-y-3">{paystackBatches.map(batch => <details key={batch.id} className="border-b border-black/5 pb-3 last:border-0"><summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">{new Date(batch.createdAt).toLocaleString()} · {batch.employeeCount} staff</span><span className="flex items-center gap-2"><span>{fmtMoney(batch.totalKES, 'KES')}</span><Badge tone={batch.status === 'success' ? 'success' : batch.status === 'failed' || batch.status === 'partial' ? 'warning' : 'info'}>{batch.status}</Badge></span></summary><div className="mt-3 divide-y divide-black/5">{batch.transfers.map(transfer => <div key={transfer.reference} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm"><div><p className="font-medium">{transfer.staffName}</p>{transfer.failureReason && <p className="text-xs text-amber-700">{transfer.failureReason}</p>}</div><span className="flex items-center gap-2">{fmtMoney(transfer.amountKES, 'KES')}<Badge tone={transfer.status === 'success' ? 'success' : transfer.status === 'failed' || transfer.status === 'reversed' || transfer.status === 'review' ? 'warning' : 'info'}>{transfer.status}</Badge></span></div>)}</div></details>)}</div>}
      </Card>

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
