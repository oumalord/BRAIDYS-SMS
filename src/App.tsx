import { useEffect, useState } from 'react';
import { Home, Calendar, Users, Scissors, Contact, ShoppingCart, Package, DollarSign, Sparkles, Menu, X, Tag, BarChart3, CreditCard, Percent, ClipboardList, Building2, KeyRound } from 'lucide-react';
import { AuthApi, BranchesApi, StaffApi } from './lib/api';
import { Button, Field, Input, Modal, ToastHost, toast } from './components/ui';
import type { Branch, Role } from './types';
import Dashboard from './tabs/Dashboard';
import Appointments from './tabs/Appointments';
import Queue from './tabs/Queue';
import StaffTab from './tabs/Staff';
import CustomersTab from './tabs/Customers';
import POS from './tabs/POS';
import Inventory from './tabs/Inventory';
import Finance from './tabs/Finance';
import AIAssistant from './tabs/AIAssistant';
import Services from './tabs/Services';
import Reports from './tabs/Reports';
import Memberships from './tabs/Memberships';
import Promotions from './tabs/Promotions';
import CustomerBooking from './tabs/CustomerBooking';
import AuditLogs from './tabs/AuditLogs';
import CustomerDashboard from './tabs/CustomerDashboard';
import EmployeeDashboard from './tabs/EmployeeDashboard';
import AuthScreen from './components/AuthScreen';
import Admin from './tabs/Admin';

type TabKey = 'dashboard' | 'appointments' | 'queue' | 'messages' | 'staff' | 'customers' | 'pos' | 'inventory' | 'services' | 'memberships' | 'promotions' | 'reports' | 'finance' | 'ai' | 'booking' | 'logs' | 'admin';

const TABS: { key: TabKey; label: string; icon: any; roles: Role[] }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: Home, roles: ['owner', 'barber', 'customer', 'admin'] },
  { key: 'appointments', label: 'Appointments', icon: Calendar, roles: ['owner', 'manager', 'receptionist', 'barber', 'admin'] },
  { key: 'queue', label: 'Queue', icon: Users, roles: ['owner', 'manager', 'receptionist', 'barber', 'admin'] },
  { key: 'staff', label: 'Staff & Chairs', icon: Scissors, roles: ['owner', 'manager', 'receptionist', 'admin'] },
  { key: 'services', label: 'Services', icon: Tag, roles: ['owner', 'manager', 'receptionist', 'admin'] },
  { key: 'memberships', label: 'Memberships', icon: CreditCard, roles: ['owner', 'admin'] },
  { key: 'promotions', label: 'Promotions', icon: Percent, roles: ['owner', 'manager', 'receptionist', 'admin'] },
  { key: 'customers', label: 'Customers', icon: Contact, roles: ['owner', 'manager', 'receptionist', 'admin'] },
  { key: 'pos', label: 'Point of Sale', icon: ShoppingCart, roles: ['owner', 'manager', 'receptionist', 'barber', 'admin'] },
  { key: 'inventory', label: 'Inventory', icon: Package, roles: ['owner', 'admin'] },
  { key: 'finance', label: 'Finance', icon: DollarSign, roles: ['owner', 'admin'] },
  { key: 'reports', label: 'Reports', icon: BarChart3, roles: ['owner', 'manager', 'receptionist', 'admin'] },
  { key: 'ai', label: 'AI Assistant', icon: Sparkles, roles: ['owner', 'admin'] },
  { key: 'booking', label: 'Book Appointment', icon: Calendar, roles: ['customer'] },
  { key: 'logs', label: 'Audit Logs', icon: ClipboardList, roles: ['owner'] },
  { key: 'admin', label: 'Admin', icon: Building2, roles: ['admin'] },
];

function normalizeRole(role: unknown): Role {
  const value = String(role || '').trim().toLowerCase();
  if (value === 'owner' || value === 'manager' || value === 'receptionist' || value === 'barber' || value === 'customer' || value === 'admin') return value;
  if (value.includes('nail')) return 'barber';
  if (value.includes('hair') || value.includes('stylist') || value.includes('spa') || value.includes('makeup')) return 'barber';
  return 'barber';
}

function initialTabFor(account: any | null): TabKey {
  if (account?.role === 'admin') return 'admin';
  const firstAllowed = TABS.find(tab => tab.roles.includes(normalizeRole(account?.role)));
  return firstAllowed?.key || 'dashboard';
}

function SelectBranch({ branches, value, onChange }: { branches: Branch[]; value: string; onChange: (value: string) => void }) {
  return <label className="flex min-w-0 items-center gap-2 text-xs text-gray-300"><span className="hidden lg:inline">Working branch</span><select aria-label="Working branch" value={value} onChange={event => onChange(event.target.value)} className="max-w-[160px] rounded-lg border border-white/20 bg-black/30 px-2 py-1.5 text-[10px] text-white sm:max-w-none sm:text-xs"><option value="">All branches</option>{branches.map(branch => <option key={branch.id} value={branch.id} className="text-[#1D1D1F]">{branch.name}</option>)}</select></label>;
}

function App() {
  const [ready] = useState(true);
  const [tab, setTab] = useState<TabKey>('dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const [account, setAccount] = useState<any | null>(null);
  const [pinForm, setPinForm] = useState({ pin: '', confirm: '' });
  const [savingPin, setSavingPin] = useState(false);
  const [posAppointment, setPosAppointment] = useState<any | undefined>(undefined);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState(() => window.localStorage.getItem('safigroom_selected_branch') || '');
  const effectiveRole = normalizeRole(account?.role);
  const mustChangePin = Boolean(account?.requiresPinChange && ['barber', 'receptionist'].includes(effectiveRole));

  const changeInitialPin = async () => {
    if (!/^\d{4}$/.test(pinForm.pin) || pinForm.pin !== pinForm.confirm) { toast('Enter matching 4-digit PINs.', 'error'); return; }
    setSavingPin(true);
    try {
      await StaffApi.changeMyPin(pinForm.pin);
      const updatedAccount = { ...account, requiresPinChange: false };
      setAccount(updatedAccount);
      window.localStorage.setItem('safigroom_account', JSON.stringify(updatedAccount));
      setPinForm({ pin: '', confirm: '' });
      toast('PIN changed successfully.', 'success');
    } catch (cause: any) { toast(cause?.message || 'Could not change your PIN.', 'error'); }
    finally { setSavingPin(false); }
  };

  useEffect(() => {
    if (!['owner', 'admin'].includes(effectiveRole)) return;
    let alive = true;
    BranchesApi.list().then(loaded => {
      if (!alive) return;
      setBranches(loaded);
      const saved = window.localStorage.getItem('safigroom_selected_branch');
      const next = loaded.some(branch => branch.id === saved) ? saved! : account.branchId || loaded[0]?.id || '';
      setSelectedBranchId(next);
      if (next) window.localStorage.setItem('safigroom_selected_branch', next);
    }).catch(() => {});
    return () => { alive = false; };
  }, [account, effectiveRole]);

  const selectBranch = (branchId: string) => {
    setSelectedBranchId(branchId);
    window.localStorage.setItem('safigroom_selected_branch', branchId);
  };

  useEffect(() => {
    const visible = TABS.filter(t => t.roles.includes(effectiveRole));
    if (!visible.find(t => t.key === tab)) {
      setTab(visible[0]?.key || 'dashboard');
    }
  }, [account, tab]);

  const visibleTabs = TABS.filter(t => t.roles.includes(effectiveRole) && (t.key !== 'admin' || account?.role === 'admin'));
  if (account?.role === 'admin') visibleTabs.sort((first, second) => (first.key === 'admin' ? -1 : second.key === 'admin' ? 1 : 0));
  const isOwner = effectiveRole === 'owner' || effectiveRole === 'admin';

  if (!account) return <AuthScreen onAuthenticated={authenticatedAccount => {
    setAccount(authenticatedAccount);
    setTab(initialTabFor(authenticatedAccount));
  }} />;

  return (
    <div className="min-h-screen bg-transparent text-white md:flex">
      <div className="fixed inset-0 -z-10 bg-[#071a3d]">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0d47a1]/70 via-[#071a3d]/85 to-[#087f9f]/70" />
      </div>

      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-white focus:text-[#1D1D1F] focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg">Skip to content</a>

      {isOwner && (
        <aside className="hidden md:flex md:flex-col md:w-64 md:flex-shrink-0 bg-black/45 backdrop-blur-2xl border-r border-white/10 md:h-screen md:sticky md:top-0">
          <div className="flex items-center gap-2 px-5 h-16 border-b border-white/10 flex-shrink-0">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#2F6BFF] to-[#00A6D6] flex items-center justify-center text-white font-semibold shadow-lg shadow-[#00A6D6]/20">S</div>
            <span className="font-semibold tracking-tight text-lg text-white">SafiGroom <span className="bg-gradient-to-r from-[#8bb7ff] to-[#61e6ff] bg-clip-text text-transparent">OS</span></span>
          </div>
          <nav aria-label="Main sections" className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
            {visibleTabs.map(t => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  aria-current={active ? 'page' : undefined}
                        className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4C82FF] ${active ? 'bg-gradient-to-r from-[#2F6BFF] to-[#00A6D6] text-white shadow-lg shadow-[#00A6D6]/20' : 'text-gray-300 hover:bg-white/10 hover:text-white'}`}
                >
                  <Icon size={16} aria-hidden="true" />
                  {t.label}
                </button>
              );
            })}
          </nav>
          <div className="px-5 py-4 border-t border-white/10 flex-shrink-0">
            <p className="text-xs text-gray-400">Signed in as {account?.name}</p>
            <p className="text-xs text-gray-300 mt-1">{account?.salonName || 'All Salons'}</p>
            <button className="text-xs text-gray-300 underline mt-2" onClick={() => { AuthApi.logout(); setAccount(null); }}>Log out</button>
          </div>
        </aside>
      )}

      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-40 border-b border-white/10 bg-black/40 backdrop-blur-2xl">
          <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-2 px-3 sm:px-6">
            <div className={`flex min-w-0 items-center gap-2 ${isOwner ? 'md:hidden' : ''}`}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#2F6BFF] to-[#00A6D6] text-sm font-semibold text-white shadow-lg shadow-[#00A6D6]/20">S</div>
              <span className="truncate text-base font-semibold tracking-tight text-white sm:text-lg">SafiGroom <span className="bg-gradient-to-r from-[#8bb7ff] to-[#61e6ff] bg-clip-text text-transparent">OS</span></span>
            </div>
            {isOwner && <div className="hidden md:block font-semibold text-white">{visibleTabs.find(t => t.key === tab)?.label}</div>}
            <div className={`hidden items-center gap-3 sm:flex ${isOwner ? 'md:hidden' : ''}`}>
              <span className="truncate text-[10px] text-gray-300 sm:text-xs">{account?.salonName || 'All Salons'} · {account?.name}</span><button className="text-[10px] text-gray-300 underline sm:text-xs" onClick={() => { AuthApi.logout(); setAccount(null); }}>Log out</button>
            </div>
            {effectiveRole === 'owner' && branches.length > 0 && <div className="shrink-0"><SelectBranch branches={branches} value={selectedBranchId} onChange={selectBranch} /></div>}
            <button className="rounded-lg p-2 text-white hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#4C82FF] sm:hidden" aria-label={menuOpen ? 'Close menu' : 'Open menu'} onClick={() => setMenuOpen(m => !m)}>
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
          {menuOpen && (
            <div className="space-y-3 border-t border-white/10 px-3 pb-3 pt-3 sm:hidden">
              <div className="text-xs text-gray-300">{account?.name} · {account?.salonName || 'All Salons'} <button className="ml-2 underline" onClick={() => { AuthApi.logout(); setAccount(null); }}>Log out</button></div>
              {isOwner && (
                <nav aria-label="Main sections" className="grid grid-cols-2 gap-1">
                  {visibleTabs.map(t => {
                    const Icon = t.icon;
                    const active = tab === t.key;
                    return (
                      <button
                        key={t.key}
                        onClick={() => { setTab(t.key); setMenuOpen(false); }}
                        aria-current={active ? 'page' : undefined}
                        className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4C82FF] ${active ? 'bg-gradient-to-r from-[#2F6BFF] to-[#00A6D6] text-white' : 'text-gray-200 hover:bg-white/10'}`}
                      >
                        <Icon size={14} aria-hidden="true" />
                        {t.label}
                      </button>
                    );
                  })}
                </nav>
              )}
            </div>
          )}
          <nav aria-label="Main sections" className={`mx-auto max-w-7xl overflow-x-auto px-3 pb-2 no-scrollbar sm:px-6 ${isOwner ? 'md:hidden' : ''}`}>
            <div className="flex min-w-max gap-1">
              {visibleTabs.map(t => {
                const Icon = t.icon;
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4C82FF] sm:px-3.5 sm:text-sm ${active ? 'bg-gradient-to-r from-[#2F6BFF] to-[#00A6D6] text-white shadow-md shadow-[#00A6D6]/20' : 'text-gray-300 hover:bg-white/10 hover:text-white'}`}
                  >
                    <Icon size={15} aria-hidden="true" />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </nav>
        </header>

        <main id="main-content" className="mx-auto max-w-7xl px-2 pb-24 pt-3 sm:px-6 sm:pb-8 sm:pt-8">
          <div key={selectedBranchId} className="min-h-[75vh] rounded-[20px] bg-[#F5F5F7] p-3 text-[#1D1D1F] shadow-2xl sm:rounded-[32px] sm:p-8">
            {!ready ? (
              <div className="flex items-center justify-center py-24 text-[#6E6E73]" role="status">Loading SafiGroom OS…</div>
            ) : (
              <>
                {tab === 'dashboard' && (effectiveRole === 'owner' || effectiveRole === 'admin') && <Dashboard />}
                {tab === 'dashboard' && effectiveRole === 'barber' && <EmployeeDashboard account={account} onAddService={appointment => { setPosAppointment(appointment); setTab('pos'); }} />}
                {tab === 'dashboard' && effectiveRole === 'customer' && <CustomerDashboard account={account} onBook={() => setTab('booking')} />}
                {tab === 'appointments' && <Appointments role={effectiveRole} />}
                {tab === 'queue' && <Queue />}
                {tab === 'staff' && <StaffTab role={effectiveRole} />}
                {tab === 'services' && <Services />}
                {tab === 'memberships' && <Memberships />}
                {tab === 'promotions' && <Promotions role={effectiveRole} />}
                {tab === 'customers' && <CustomersTab role={effectiveRole} />}
                {tab === 'pos' && <POS appointment={posAppointment} currentStaffId={account?.staffId} onSaleComplete={() => { setPosAppointment(undefined); toast('Sale completed and recorded.', 'success'); }} />}
                {tab === 'inventory' && <Inventory />}
                {tab === 'finance' && <Finance />}
                {tab === 'reports' && <Reports role={effectiveRole} />}
                {tab === 'ai' && <AIAssistant />}
                {tab === 'booking' && <CustomerBooking account={account} />}
                {tab === 'logs' && <AuditLogs />}
                {tab === 'admin' && account?.role === 'admin' && <Admin />}
              </>
            )}
          </div>
        </main>
      </div>
      {isOwner && (
        <div className="fixed inset-x-0 bottom-0 z-50 border-t border-white/10 bg-black/75 px-2 py-2 backdrop-blur-xl sm:hidden">
          <nav aria-label="Bottom tab bar" className="overflow-x-auto no-scrollbar">
            <div className="flex min-w-max items-center justify-between gap-1">
              {visibleTabs.map(t => {
                const Icon = t.icon;
                const active = tab === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setTab(t.key)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-w-[70px] flex-col items-center gap-1 rounded-xl px-2 py-2 text-[10px] font-medium transition-colors ${active ? 'bg-gradient-to-r from-[#2F6BFF] to-[#00A6D6] text-white shadow-md shadow-[#00A6D6]/20' : 'text-gray-300'}`}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span className="leading-none">{t.label.split(' ')[0]}</span>
                  </button>
                );
              })}
            </div>
          </nav>
        </div>
      )}
      {mustChangePin && <Modal title="Change your PIN" onClose={() => {}} footer={<Button onClick={changeInitialPin} disabled={savingPin}>{savingPin ? 'Saving...' : 'Save new PIN'}</Button>}>
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl bg-[#0071e3]/10 p-3 text-sm text-[#0058b0]"><KeyRound size={18} aria-hidden="true" /><span>Change the default PIN before continuing.</span></div>
          <Field label="New 4-digit PIN" htmlFor="first-login-pin"><Input id="first-login-pin" type="password" inputMode="numeric" maxLength={4} value={pinForm.pin} onChange={event => setPinForm(current => ({ ...current, pin: event.target.value.replace(/\D/g, '').slice(0, 4) }))} /></Field>
          <Field label="Confirm new PIN" htmlFor="first-login-pin-confirm"><Input id="first-login-pin-confirm" type="password" inputMode="numeric" maxLength={4} value={pinForm.confirm} onChange={event => setPinForm(current => ({ ...current, confirm: event.target.value.replace(/\D/g, '').slice(0, 4) }))} /></Field>
        </div>
      </Modal>}
      <ToastHost />
    </div>
  );
}

export default App;
