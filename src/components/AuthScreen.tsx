import { useEffect, useState } from 'react';
import { Building2, LogIn, UserPlus } from 'lucide-react';
import { AuthApi, PublicApi } from '../lib/api';
import { Button, Card, Field, Input, Select, ToastHost, toast } from './ui';

interface SalonOption { id: string; name: string; }
interface BranchOption { id: string; name: string; }

export default function AuthScreen({ onAuthenticated }: { onAuthenticated: (account: any) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ name: '', phone: '', email: '', identifier: '', pin: '', salonId: '', branchId: '' });
  const [salons, setSalons] = useState<SalonOption[]>([]);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [activeField, setActiveField] = useState<'identifier' | 'pin' | null>(null);

  const switchMode = (nextMode: 'login' | 'signup') => {
    setMode(nextMode);
    if (nextMode === 'signup') setForm(previous => ({ ...previous, email: '', identifier: '', pin: '' }));
  };

  useEffect(() => { PublicApi.salons().then(setSalons).catch(() => {}); }, []);

  useEffect(() => {
    if (mode !== 'signup' || !form.salonId) { setBranches([]); return; }
    let active = true;
    setBranchesLoading(true);
    PublicApi.branches(form.salonId).then(loaded => {
      if (active) setBranches(loaded);
    }).catch(() => {
      if (active) setBranches([]);
    }).finally(() => {
      if (active) setBranchesLoading(false);
    });
    return () => { active = false; };
  }, [form.salonId, mode]);

  const submit = async (event?: React.FormEvent<HTMLFormElement>) => {
    const submitted = event ? new FormData(event.currentTarget) : null;
    const identifier = mode === 'login' ? form.identifier || String(submitted?.get('auth-identifier') || '') : form.email || String(submitted?.get('auth-email') || '');
    const pin = form.pin || String(submitted?.get('auth-pin') || '');
    if (mode === 'login' && (!identifier.trim() || !pin)) { toast('Email or phone and a PIN or password are required.', 'error'); return; }
    if (mode === 'signup' && !pin) { toast('A 4-digit PIN is required.', 'error'); return; }
    if (mode === 'signup' && (!form.salonId || !form.branchId || !form.name.trim() || !form.phone.trim())) { toast('Choose a salon, branch and complete your client details.', 'error'); return; }
    setBusy(true);
    try {
      const account = mode === 'login' ? await AuthApi.login(identifier, pin) : await AuthApi.signup({ ...form, email: identifier, pin });
      onAuthenticated(account);
    } catch (cause: any) { toast(cause?.message || 'Authentication failed.', 'error'); }
    finally { setBusy(false); }
  };

  const setupDemoAdmin = async () => {
    setDemoBusy(true);
    try {
      const result = await AuthApi.demo();
      const credentials = result.data.accounts[0];
      setMode('login');
      setForm(previous => ({ ...previous, identifier: credentials.email, pin: credentials.password }));
      toast('Platform admin access is ready. You can log in now.', 'success');
    } catch (cause: any) { toast(cause?.message || 'Could not prepare platform admin access.', 'error'); }
    finally { setDemoBusy(false); }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#071a3d]">
      <video
        className="absolute inset-0 h-full w-full object-cover"
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        poster="https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f?auto=format&fit=crop&w=1600&q=80"
      >
        <source src="https://v1.pinimg.com/videos/iht/expMp4/62/8c/9e/628c9e4a8b30c495271a35ef16b66bbb_720w.mp4" type="video/mp4" />
      </video>
      <div className="absolute inset-0 bg-[#071a3d]/60 backdrop-blur-[1px]" />

      <div className="relative z-10 flex min-h-screen items-center justify-center p-3 sm:p-4">
        <Card className="w-full max-w-[92vw] border border-white/70 bg-white/95 p-4 text-[#1D1D1F] shadow-2xl shadow-[#040b1c]/50 backdrop-blur-md sm:max-w-md sm:p-7">
          <div className="text-center mb-6">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-gradient-to-br from-[#2F6BFF] to-[#00A6D6] text-white flex items-center justify-center"><Building2 size={23} aria-hidden="true" /></div>
            <h1 className="text-2xl font-semibold mt-4 text-[#1D1D1F]">SafiGroom OS</h1>
            <p className="text-sm text-[#6E6E73]">Salon operations and customer care</p>
          </div>
          <div className="flex gap-1 bg-black/5 rounded-full p-1 mb-5 border border-black/10">
            <button className={`flex-1 rounded-full py-2 text-sm ${mode === 'login' ? 'bg-white text-[#1D1D1F] shadow-sm font-medium' : 'text-[#6E6E73]'}`} onClick={() => switchMode('login')}><LogIn size={14} className="inline mr-1" />Log in</button>
            <button className={`flex-1 rounded-full py-2 text-sm ${mode === 'signup' ? 'bg-white text-[#1D1D1F] shadow-sm font-medium' : 'text-[#6E6E73]'}`} onClick={() => switchMode('signup')}><UserPlus size={14} className="inline mr-1" />Client sign up</button>
          </div>
          <form className="space-y-4" autoComplete="off" onSubmit={event => { event.preventDefault(); void submit(event); }}>
            {mode === 'signup' && <>
              <Field label="Salon to visit" htmlFor="auth-salon"><Select className="border-black/20 text-[#1D1D1F] focus-visible:ring-[#2F6BFF]" id="auth-salon" value={form.salonId} onChange={e => setForm({ ...form, salonId: e.target.value, branchId: '' })}><option value="">Choose an existing salon</option>{salons.map(salon => <option key={salon.id} value={salon.id}>{salon.name}</option>)}</Select></Field>
              <Field label="Branch to visit" htmlFor="auth-branch"><Select className="border-black/20 text-[#1D1D1F] focus-visible:ring-[#2F6BFF]" id="auth-branch" value={form.branchId} disabled={!form.salonId || branchesLoading} onChange={e => setForm({ ...form, branchId: e.target.value })}><option value="">{branchesLoading ? 'Loading branches...' : form.salonId ? 'Choose a branch' : 'Choose a salon first'}</option>{branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</Select></Field>
              <Field label="Full name" htmlFor="auth-name"><Input className="border-black/20 text-[#1D1D1F] placeholder:text-[#6E6E73] focus-visible:ring-[#2F6BFF]" id="auth-name" autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Phone" htmlFor="auth-phone"><Input className="border-black/20 text-[#1D1D1F] placeholder:text-[#6E6E73] focus-visible:ring-[#2F6BFF]" id="auth-phone" autoComplete="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field>
            </>}
            {mode === 'login' ? <Field label="Email or phone" htmlFor="auth-identifier"><Input className="border-black/20 text-[#1D1D1F] placeholder:text-[#6E6E73] focus-visible:ring-[#2F6BFF]" id="auth-identifier" name="auth-identifier" autoComplete="username" readOnly={activeField !== 'identifier'} value={form.identifier} onFocus={() => setActiveField('identifier')} onChange={e => setForm({ ...form, identifier: e.target.value })} /></Field> : <Field label="Email (optional)" htmlFor="auth-email"><Input className="border-black/20 text-[#1D1D1F] placeholder:text-[#6E6E73] focus-visible:ring-[#2F6BFF]" id="auth-email" name="auth-email" autoComplete="off" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>}
            <Field label={mode === 'login' ? 'Password or PIN' : 'Create 4-digit PIN'} htmlFor="auth-pin"><Input className="border-black/20 text-[#1D1D1F] placeholder:text-[#6E6E73] focus-visible:ring-[#2F6BFF]" id="auth-pin" name="auth-pin" autoComplete="current-password" inputMode="numeric" maxLength={4} pattern="[0-9]{4}" readOnly={activeField !== 'pin'} type="password" value={form.pin} onFocus={() => setActiveField('pin')} onChange={e => setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></Field>
            <Button type="submit" className="w-full" disabled={busy}>{busy ? 'Please wait...' : mode === 'login' ? 'Log in' : 'Create client account'}</Button>
          </form>
          <p className="text-xs text-[#6E6E73] border-t border-black/10 mt-6 pt-5">Salon and employee accounts are created by the platform administrator or salon owner.</p>
          <button type="button" className="mt-3 text-xs font-medium text-[#2F6BFF] hover:underline disabled:opacity-50" onClick={setupDemoAdmin} disabled={demoBusy}>{demoBusy ? 'Preparing admin access...' : 'Set up platform admin access'}</button>
        </Card>
        <ToastHost />
      </div>
    </div>
  );
}
