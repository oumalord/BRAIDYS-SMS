import { useEffect, useState } from 'react';
import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, ButtonHTMLAttributes } from 'react';
import { X, AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-3xl bg-white border border-black/5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}>{children}</div>;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}

export function Button({ children, variant = 'primary', size = 'md', className = '', ...rest }: ButtonProps) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2F6BFF] focus-visible:ring-offset-2';
  const sizes = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm';
  const variants: Record<string, string> = {
    primary: 'bg-gradient-to-r from-[#2F6BFF] to-[#E619B0] text-white hover:brightness-110 shadow-md shadow-[#E619B0]/20',
    secondary: 'bg-white text-[#1D1D1F] border border-black/10 hover:bg-black/[0.03]',
    ghost: 'text-[#1D1D1F] hover:bg-black/5',
    danger: 'bg-[#FF3B30] text-white hover:bg-[#e0342b]',
  };
  return <button className={`${base} ${sizes} ${variants[variant]} ${className}`} {...rest}>{children}</button>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }) {
  const tones: Record<string, string> = {
    neutral: 'bg-black/5 text-[#1D1D1F]',
    success: 'bg-[#34C759]/10 text-[#1c7c34]',
    warning: 'bg-[#FF9500]/10 text-[#9a5c00]',
    danger: 'bg-[#FF3B30]/10 text-[#b0201a]',
    info: 'bg-[#0071e3]/10 text-[#0058b0]',
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function Field({ label, htmlFor, error, children, hint }: { label: string; htmlFor: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-[#1D1D1F]">{label}</label>
      {children}
      {hint && !error && <span className="text-xs text-[#6E6E73]">{hint}</span>}
      {error && <span id={`${htmlFor}-error`} className="text-xs text-[#FF3B30] flex items-center gap-1"><AlertCircle size={12} aria-hidden="true" />{error}</span>}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`w-full rounded-xl border border-black/10 bg-white px-3.5 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2F6BFF] ${props.className || ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`w-full rounded-xl border border-black/10 bg-white px-3.5 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2F6BFF] ${props.className || ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`w-full rounded-xl border border-black/10 bg-white px-3.5 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2F6BFF] ${props.className || ''}`} />;
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={e => e.stopPropagation()} className="w-full max-h-[90vh] flex flex-col rounded-3xl bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-6 pb-4 flex-shrink-0">
          <h2 id="modal-title" className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog" className="p-1.5 rounded-full hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-[#2F6BFF]"><X size={18} /></button>
        </div>
        <div className="px-6 overflow-y-auto flex-1 min-h-0">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-6 py-4 border-t border-black/5 flex-shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: any; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="w-12 h-12 rounded-2xl bg-black/5 flex items-center justify-center mb-4"><Icon size={22} className="text-[#6E6E73]" aria-hidden="true" /></div>
      <h3 className="font-medium text-[#1D1D1F] mb-1">{title}</h3>
      <p className="text-sm text-[#6E6E73] max-w-sm mb-4">{description}</p>
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div role="status" className="flex items-center gap-2 text-sm text-[#6E6E73] py-10 justify-center"><Loader2 size={16} className="animate-spin" aria-hidden="true" />{label}</div>;
}

export function StatCard({ label, value, sub, icon: Icon, tone = 'neutral' }: { label: string; value: string; sub?: string; icon: any; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const toneColor: Record<string, string> = { neutral: 'text-[#2F6BFF]', success: 'text-[#34C759]', warning: 'text-[#FF9500]', danger: 'text-[#FF3B30]' };
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-[#6E6E73] mb-1">{label}</p>
          <p className="text-2xl font-semibold tracking-tight">{value}</p>
          {sub && <p className="text-xs text-[#6E6E73] mt-1">{sub}</p>}
        </div>
        <div className={`w-9 h-9 rounded-xl bg-black/5 flex items-center justify-center ${toneColor[tone]}`}><Icon size={16} aria-hidden="true" /></div>
      </div>
    </Card>
  );
}

type ToastKind = 'success' | 'error' | 'info';
interface ToastMsg { id: number; text: string; kind: ToastKind; }
let toastListeners: ((m: ToastMsg) => void)[] = [];

export function toast(text: string, kind: ToastKind = 'info') {
  toastListeners.forEach(l => l({ id: Date.now() + Math.random(), text, kind }));
}

export function ToastHost() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(() => {
    const l = (m: ToastMsg) => {
      setItems(prev => [...prev, m]);
      setTimeout(() => setItems(prev => prev.filter(x => x.id !== m.id)), 4000);
    };
    toastListeners.push(l);
    return () => { toastListeners = toastListeners.filter(x => x !== l); };
  }, []);
  const icons: Record<ToastKind, any> = { success: CheckCircle2, error: AlertCircle, info: Info };
  const colors: Record<ToastKind, string> = { success: 'bg-[#1c7c34]', error: 'bg-[#b0201a]', info: 'bg-[#1D1D1F]' };
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm" aria-live="polite" role="status">
      {items.map(t => {
        const Icon = icons[t.kind];
        return (
          <div key={t.id} className={`${colors[t.kind]} text-white rounded-2xl px-4 py-3 shadow-lg flex items-center gap-2 text-sm`}>
            <Icon size={16} aria-hidden="true" />{t.text}
          </div>
        );
      })}
    </div>
  );
}
