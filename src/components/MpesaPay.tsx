import { useEffect, useRef, useState } from 'react';
import { Smartphone, CheckCircle2, Loader2 } from 'lucide-react';
import { Modal, Button, Field, Input, toast } from './ui';
import { MpesaApi } from '../lib/api';

type Stage = 'enter-phone' | 'sending' | 'waiting' | 'success' | 'error';

export function MpesaPayModal({ amountKES, purpose, referenceId, initialPhone, onSuccess, onClose }: { amountKES: number; purpose: string; referenceId?: string; initialPhone?: string; onSuccess: (receiptNumber: string) => void; onClose: () => void; }) {
  const [phone, setPhone] = useState(initialPhone || '');
  const [stage, setStage] = useState<Stage>('enter-phone');
  const [receipt, setReceipt] = useState('');
  const pollRef = useRef<number | null>(null);

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  const send = async () => {
    const clean = phone.replace(/\s+/g, '');
    if (!/^(?:\+254|0)(7\d{8}|1\d{8})$/.test(clean)) { toast('Enter a valid Kenyan M-Pesa phone number.', 'error'); return; }
    setStage('sending');
    try {
      const { data } = await MpesaApi.stkPush({ phone: clean, amountKES, purpose, referenceId });
      setStage('waiting');
      pollRef.current = window.setInterval(async () => {
        const res = await MpesaApi.status(data.id);
        if (res.data.status === 'completed') {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setReceipt(res.data.mpesaReceiptNumber);
          setStage('success');
        } else if (res.data.status === 'failed') {
          if (pollRef.current) window.clearInterval(pollRef.current);
          toast(res.data.failureReason || 'M-Pesa payment failed.', 'error');
          setStage('error');
        }
      }, 1500);
    } catch (cause: any) {
      toast(cause?.message || 'Could not send the payment request.', 'error');
      setStage('error');
    }
  };

  return (
    <Modal title="M-Pesa Payment" onClose={onClose} footer={
      stage === 'enter-phone' ? (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={send}>Send STK Push</Button>
        </>
      ) : stage === 'success' ? (
        <Button onClick={() => onSuccess(receipt)}>Done</Button>
      ) : stage === 'error' ? (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => setStage('enter-phone')}>Try Again</Button>
        </>
      ) : null
    }>
      {stage === 'enter-phone' && (
        <div className="space-y-4">
          <div className="rounded-2xl bg-black/5 p-4 flex items-center gap-3">
            <Smartphone size={20} className="text-[#0071e3]" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium">Amount to pay</p>
              <p className="text-lg font-semibold">KES {Math.round(amountKES).toLocaleString()}</p>
            </div>
          </div>
          <Field label="M-Pesa phone number" htmlFor="mpesa-phone"><Input id="mpesa-phone" value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 0712345678" /></Field>
          <p className="text-xs text-[#6E6E73]">The customer will receive a prompt on their phone to enter their M-Pesa PIN and confirm payment.</p>
        </div>
      )}
      {(stage === 'sending' || stage === 'waiting') && (
        <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
          <Loader2 size={28} className="animate-spin text-[#0071e3]" aria-hidden="true" />
          <p className="font-medium">{stage === 'sending' ? 'Sending payment request…' : `Waiting for ${phone} to confirm…`}</p>
          <p className="text-xs text-[#6E6E73]">Ask the customer to check their phone and enter their M-Pesa PIN.</p>
        </div>
      )}
      {stage === 'success' && (
        <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
          <CheckCircle2 size={32} className="text-[#34C759]" aria-hidden="true" />
          <p className="font-medium">Payment received</p>
          <p className="text-xs text-[#6E6E73]">M-Pesa receipt: <span className="font-mono">{receipt}</span></p>
        </div>
      )}
      {stage === 'error' && (
        <div className="flex flex-col items-center justify-center py-8 text-center gap-3">
          <p className="font-medium">Could not send the payment request.</p>
          <p className="text-xs text-[#6E6E73]">Check the phone number and try again.</p>
        </div>
      )}
    </Modal>
  );
}
