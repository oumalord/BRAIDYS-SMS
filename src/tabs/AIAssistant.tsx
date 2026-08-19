import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send } from 'lucide-react';
import { Card, Button, Input } from '../components/ui';
import { AiApi } from '../lib/api';

const SUGGESTIONS = ['What is our revenue this month?', 'Which staff member generated the most revenue?', 'What products are low on stock?', 'Which customers have not visited in 60 days?', 'What are our busiest hours?'];

interface ChatMsg { id: number; role: 'user' | 'assistant'; text: string; grounded?: boolean; }

function AIAssistant() {
  const [messages, setMessages] = useState<ChatMsg[]>([
    { id: 0, role: 'assistant', text: "Hi, I'm your AI Business Manager. I answer using your business's actual recorded data — never estimates. Ask me about revenue, staff performance, inventory, or customer activity.", grounded: true },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const ask = async (question: string) => {
    if (!question.trim() || loading) return;
    const userMsg: ChatMsg = { id: Date.now(), role: 'user', text: question };
    setMessages(m => [...m, userMsg]);
    setInput('');
    setLoading(true);
    try {
      const { data } = await AiApi.ask(question);
      setMessages(m => [...m, { id: Date.now() + 1, role: 'assistant', text: data.answer, grounded: data.grounded }]);
    } catch {
      setMessages(m => [...m, { id: Date.now() + 1, role: 'assistant', text: "I couldn't process that question right now. Please try again.", grounded: false }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div><h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Sparkles size={20} className="text-[#0071e3]" aria-hidden="true" />AI Business Manager</h1><p className="text-sm text-[#6E6E73]">Grounded answers from your live business data — it will say so if it doesn't know.</p></div>

      <Card className="p-5">
        <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1" role="log" aria-live="polite">
          {messages.map(m => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${m.role === 'user' ? 'bg-[#0071e3] text-white' : 'bg-black/5 text-[#1D1D1F]'}`}>
                {m.text}
                {m.role === 'assistant' && m.grounded === false && <p className="text-[10px] mt-1 opacity-60">Not answerable from current data.</p>}
              </div>
            </div>
          ))}
          {loading && <div className="text-xs text-[#6E6E73]">Thinking through your data…</div>}
          <div ref={endRef} />
        </div>
        <form onSubmit={e => { e.preventDefault(); ask(input); }} className="flex gap-2 mt-4">
          <Input aria-label="Ask the AI business manager" placeholder="Ask about revenue, staff, inventory…" value={input} onChange={e => setInput(e.target.value)} />
          <Button type="submit" disabled={loading}><Send size={15} aria-hidden="true" /></Button>
        </form>
      </Card>

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map(s => (
          <button key={s} onClick={() => ask(s)} className="text-xs rounded-full border border-black/10 bg-white px-3 py-1.5 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3]">{s}</button>
        ))}
      </div>
    </div>
  );
}

export default AIAssistant;
