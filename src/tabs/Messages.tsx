import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Send, ShieldCheck } from 'lucide-react';
import { Card, Select, Input, Button, LoadingState } from '../components/ui';
import { MessagesApi, StaffApi } from '../lib/api';
import type { ChatChannel, ChatMessage, Role, Staff } from '../types';

function Messages({ role }: { role: Role }) {
  const [channel, setChannel] = useState<ChatChannel>('team');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [staff, setStaff] = useState<Staff[]>([]);
  const [asStaffId, setAsStaffId] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const canSeeManagement = role === 'owner' || role === 'receptionist';

  useEffect(() => { if (role === 'barber') StaffApi.list().then(setStaff); }, [role]);
  useEffect(() => { if (!canSeeManagement && channel === 'management') setChannel('team'); }, [role, canSeeManagement, channel]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = () => { MessagesApi.list(channel).then(m => { if (alive) setMessages(m); }).catch(() => {}).finally(() => { if (alive) setLoading(false); }); };
    load();
    const id = setInterval(load, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [channel]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const senderName = role === 'owner' ? 'Business Owner' : role === 'receptionist' ? 'Front Desk (Receptionist)' : (staff.find(s => s.id === asStaffId)?.name || '');

  const send = async () => {
    if (!text.trim()) return;
    if (role === 'barber' && !asStaffId) return;
    await MessagesApi.send({ channel, senderName, senderRole: role, text: text.trim() });
    setText('');
    MessagesApi.list(channel).then(setMessages);
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><MessageSquare size={20} aria-hidden="true" />Team Messages</h1>
        <p className="text-sm text-[#6E6E73]">Chat with your team, updated in real time.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-black/5 rounded-full p-1 w-fit" role="group" aria-label="Channel">
          <button onClick={() => setChannel('team')} aria-pressed={channel === 'team'} className={`px-4 py-1.5 text-sm rounded-full font-medium ${channel === 'team' ? 'bg-white shadow-sm' : 'text-[#6E6E73]'}`}>Team Chat</button>
          {canSeeManagement && (
            <button onClick={() => setChannel('management')} aria-pressed={channel === 'management'} className={`px-4 py-1.5 text-sm rounded-full font-medium flex items-center gap-1 ${channel === 'management' ? 'bg-white shadow-sm' : 'text-[#6E6E73]'}`}><ShieldCheck size={13} aria-hidden="true" />Management</button>
          )}
        </div>
        {role === 'barber' && (
          <Select aria-label="Post as" value={asStaffId} onChange={e => setAsStaffId(e.target.value)} className="w-auto">
            <option value="">Post as…</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
      </div>

      {channel === 'management' && (
        <p className="text-xs text-[#6E6E73] flex items-center gap-1"><ShieldCheck size={12} aria-hidden="true" />Visible only to the business owner and receptionist (supervisor).</p>
      )}

      <Card className="p-5">
        {loading ? <LoadingState label="Loading messages…" /> : (
          <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1" role="log" aria-live="polite">
            {messages.length === 0 && <p className="text-sm text-[#6E6E73]">No messages yet in this channel. Say hello!</p>}
            {messages.map(m => (
              <div key={m.id} className="flex flex-col">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{m.senderName}</span>
                  <span className="text-[10px] text-[#6E6E73]">{new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="text-sm bg-black/5 rounded-2xl px-3.5 py-2 mt-1 w-fit max-w-[85%]">{m.text}</p>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
        <form onSubmit={e => { e.preventDefault(); send(); }} className="flex gap-2 mt-4">
          <Input aria-label="Message text" placeholder={role === 'barber' && !asStaffId ? 'Select who you are posting as first…' : 'Write a message…'} value={text} onChange={e => setText(e.target.value)} disabled={role === 'barber' && !asStaffId} />
          <Button type="submit" disabled={!text.trim() || (role === 'barber' && !asStaffId)}><Send size={15} aria-hidden="true" /></Button>
        </form>
      </Card>
    </div>
  );
}

export default Messages;
