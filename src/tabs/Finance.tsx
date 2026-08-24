import { useEffect, useState } from 'react';
import { Plus, Receipt } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, EmptyState, LoadingState, StatCard, toast } from '../components/ui';
import { DashboardApi, ExpensesApi, PayrollApi, PayoutsApi, fmtMoney } from '../lib/api';
import type { DashboardData, Expense, PayoutBatch, Staff } from '../types';

type Range = 'today' | 'week' | 'month' | 'all';

function Finance() {
  const [range, setRange] = useState<Range>('month');
  const [data, setData] = useState<DashboardData | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [payouts, setPayouts] = useState<PayoutBatch[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [payrollSending, setPayrollSending] = useState(false);
  const [paying, setPaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ category: 'Supplies', amount: 0, note: '', date: new Date().toISOString().slice(0, 10) });

  const load = () => {
    setLoading(true);
    Promise.all([DashboardApi.get(range), ExpensesApi.list(), PayoutsApi.list(), PayrollApi.staff()]).then(([d, e, p, s]) => { setData(d); setExpenses(e); setPayouts(p); setStaff(s); }).finally(() => setLoading(false));
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
      const { data } = await PayoutsApi.record('fortnight');
      toast(`${data.employeeCount} employees marked paid: ${fmtMoney(data.totalKES, 'KES')}. No money was sent.`, 'success');
      load();
    } catch (cause: any) {
      toast(cause?.message || 'Could not record the payout.', 'error');
    } finally {
      setPaying(false);
    }
  };

  const sendPayroll = async () => {
    const recipients = staff.map(member => ({ staffId: member.id, amountKES: (member.commissionEarned14Days || 0) + (member.assistantEarned14Days || 0), phone: member.phone })).filter(recipient => recipient.amountKES > 0);
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

  if (loading && !data) return <LoadingState label="Loading finance data…" />;

  const revenueKES = data?.revenueByCurrency.KES || 0;
  const commissionsKES = data?.commissionsByCurrency.KES || 0;
  const profitKES = data?.estimatedProfitByCurrency.KES || 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">Finance</h1><p className="text-sm text-[#6E6E73]">Revenue, commissions, expenses and profitability, computed from real transactions.</p></div>
        <div className="flex items-center gap-2">
          <Select aria-label="Date range" value={range} onChange={e => setRange(e.target.value as Range)} className="w-auto" style={{ width: 'auto' }}>
            <option value="today">Today</option><option value="week">This Week</option><option value="month">This Month</option><option value="all">All Time</option>
          </Select>
          <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />Add Expense</Button>
          <Button variant="secondary" onClick={recordPayout} disabled={paying}>{paying ? 'Recording…' : 'Mark 14-day earnings paid'}</Button>
        </div>
      </div>

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Revenue" value={fmtMoney(revenueKES, 'KES')} icon={Receipt} tone="success" />
            <StatCard label="Product Cost" value={fmtMoney(data.productCost, 'KES')} icon={Receipt} />
            <StatCard label="Commissions Owed" value={fmtMoney(commissionsKES, 'KES')} icon={Receipt} />
            <StatCard label="Commission Rate" value="50%" sub="After product and helper deductions" icon={Receipt} tone="warning" />
          </div>
          <Card className="p-6">
            <h2 className="font-semibold mb-4">Profitability Breakdown</h2>
            <div className="space-y-2 text-sm max-w-md">
              <div className="flex justify-between"><span className="text-[#6E6E73]">Revenue</span><span>{fmtMoney(revenueKES, 'KES')}</span></div>
              <div className="flex justify-between"><span className="text-[#6E6E73]">− Product cost (inventory consumed)</span><span>-{fmtMoney(data.productCost, 'KES')}</span></div>
              <div className="flex justify-between"><span className="text-[#6E6E73]">− Staff commissions</span><span>-{fmtMoney(commissionsKES, 'KES')}</span></div>
              <div className="flex justify-between"><span className="text-[#6E6E73]">− Recorded expenses</span><span>-{fmtMoney(data.expenseTotal, 'KES')}</span></div>
              <div className="flex justify-between font-semibold text-base border-t border-black/5 pt-2 mt-2"><span>Net Profit</span><span className={profitKES >= 0 ? 'text-[#1c7c34]' : 'text-[#b0201a]'}>{fmtMoney(profitKES, 'KES')}</span></div>
            </div>
            <p className="text-xs text-[#6E6E73] mt-3">Commission is 50% of each employee's service amount after assistant payments.</p>
          </Card>
          <Card className="p-6">
            <h2 className="font-semibold mb-4">Payment Methods</h2>
            <div className="grid sm:grid-cols-3 gap-3">
              {(['Cash', 'Card', 'M-Pesa'] as const).map(method => <div key={method} className="rounded-2xl bg-black/[0.03] p-4"><p className="text-xs text-[#6E6E73]">{method}</p><p className="text-xl font-semibold mt-1">{fmtMoney(data.paymentMethodTotals[method], 'KES')}</p></div>)}
            </div>
          </Card>
          <Card className="p-6">
            <h2 className="font-semibold mb-4">Commission Statement (by staff)</h2>
            {data.topStaff.length === 0 ? <p className="text-sm text-[#6E6E73]">No commission activity for this range.</p> : (
              <table className="w-full text-sm">
                <caption className="sr-only">Commission owed per staff member</caption>
                <thead><tr className="text-left text-xs text-[#6E6E73] border-b border-black/5"><th className="pb-2">Staff</th><th className="pb-2">Services Sold</th><th className="pb-2">Revenue</th><th className="pb-2">Assistants</th><th className="pb-2">Expected income</th></tr></thead>
                <tbody>
                  {data.topStaff.map(s => (
                    <tr key={`${s.name}-${s.currency}`} className="border-b border-black/5 last:border-0">
                      <td className="py-2">{s.name}</td><td className="py-2">{s.count}</td><td className="py-2">{fmtMoney(s.revenue, s.currency)}</td><td className="py-2">-{fmtMoney(s.helperDeductions, s.currency)}</td><td className="py-2 font-medium">{fmtMoney(s.commission, s.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4"><div><h2 className="font-semibold">Payroll</h2><p className="text-xs text-[#6E6E73]">Calculated from each employee's last 14 days of service commissions and assistant payments.</p></div><Button onClick={sendPayroll} disabled={payrollSending}>{payrollSending ? 'Sending…' : 'Send payroll batch'}</Button></div>
        <div className="space-y-2">{staff.filter(member => member.employmentStatus !== 'laid-off').map(member => { const calculated = (member.commissionEarned14Days || 0) + (member.assistantEarned14Days || 0); return <div key={member.id} className="flex items-center justify-between gap-3 border-b border-black/5 pb-2"><div><p className="text-sm font-medium">{member.name}</p><p className="text-xs text-[#6E6E73]">{member.phone || 'No phone number'} · {member.branchName || member.branch}</p><p className="text-xs text-[#6E6E73]">14-day commission {fmtMoney(member.commissionEarned14Days || 0, 'KES')} + assistant pay {fmtMoney(member.assistantEarned14Days || 0, 'KES')}</p></div><p className="font-semibold text-sm">{fmtMoney(calculated, 'KES')}</p></div>; })}</div>
      </Card>

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
