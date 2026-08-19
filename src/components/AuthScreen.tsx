import { useEffect, useState } from 'react';
import { Building2, LogIn, UserPlus } from 'lucide-react';
import { AuthApi, PublicApi } from '../lib/api';
import { Button, Card, Field, Input, Select, ToastHost, toast } from './ui';

interface SalonOption { id: string; name: string; }

export default function AuthScreen({ onAuthenticated }: { onAuthenticated: (account: any) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [form, setForm] = useState({ name: '', phone: '', email: '', password: '', salonId: '' });
  const [salons, setSalons] = useState<SalonOption[]>([]);
  const [busy, setBusy] = useState(false);

  const switchMode = (nextMode: 'login' | 'signup') => {
    setMode(nextMode);
    if (nextMode === 'signup') setForm(previous => ({ ...previous, email: '', password: '' }));
  };

  useEffect(() => { PublicApi.salons().then(setSalons).catch(() => {}); }, []);

  const submit = async () => {
    if (!form.email.trim() || !form.password) { toast('Email and password are required.', 'error'); return; }
    if (mode === 'signup' && (!form.salonId || !form.name.trim() || !form.phone.trim())) { toast('Choose a salon and complete your client details.', 'error'); return; }
    setBusy(true);
    try {
      const account = mode === 'login' ? await AuthApi.login(form.email, form.password) : await AuthApi.signup(form);
      onAuthenticated(account);
    } catch (cause: any) { toast(cause?.message || 'Authentication failed.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#071a3d] flex items-center justify-center p-4">
      <Card className="w-full max-w-md p-7">
        <div className="text-center mb-6">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-gradient-to-br from-[#2F6BFF] to-[#00A6D6] text-white flex items-center justify-center"><Building2 size={23} aria-hidden="true" /></div>
          <h1 className="text-2xl font-semibold mt-4">SafiGroom OS</h1>
          <p className="text-sm text-[#6E6E73]">Salon operations and customer care</p>
        </div>
        <div className="flex gap-1 bg-black/5 rounded-full p-1 mb-5">
          <button className={`flex-1 rounded-full py-2 text-sm ${mode === 'login' ? 'bg-white shadow-sm font-medium' : 'text-[#6E6E73]'}`} onClick={() => switchMode('login')}><LogIn size={14} className="inline mr-1" />Log in</button>
          <button className={`flex-1 rounded-full py-2 text-sm ${mode === 'signup' ? 'bg-white shadow-sm font-medium' : 'text-[#6E6E73]'}`} onClick={() => switchMode('signup')}><UserPlus size={14} className="inline mr-1" />Client sign up</button>
        </div>
        <div className="space-y-4">
          {mode === 'signup' && <>
            <Field label="Salon to visit" htmlFor="auth-salon"><Select id="auth-salon" value={form.salonId} onChange={e => setForm({ ...form, salonId: e.target.value })}><option value="">Choose an existing salon</option>{salons.map(salon => <option key={salon.id} value={salon.id}>{salon.name}</option>)}</Select></Field>
            <Field label="Full name" htmlFor="auth-name"><Input id="auth-name" autoComplete="name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Phone" htmlFor="auth-phone"><Input id="auth-phone" autoComplete="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></Field>
          </>}
          <Field label="Email" htmlFor="auth-email"><Input id="auth-email" autoComplete={mode === 'signup' ? 'email' : 'username'} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Password" htmlFor="auth-password"><Input id="auth-password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>
          <Button className="w-full" onClick={submit} disabled={busy}>{busy ? 'Please wait...' : mode === 'login' ? 'Log in' : 'Create client account'}</Button>
        </div>
        <p className="text-xs text-[#6E6E73] border-t border-black/5 mt-6 pt-5">Salon and employee accounts are created by the platform administrator or salon owner.</p>
      </Card>
      <ToastHost />
    </div>
  );
}
