import { useEffect, useState } from 'react';
import { ClipboardList, RefreshCw } from 'lucide-react';
import { AuditApi } from '../lib/api';
import { Badge, Button, Card, LoadingState, EmptyState, toast } from '../components/ui';
import type { AuditLog } from '../types';

function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    AuditApi.list().then(setLogs).catch(() => toast('Could not load audit logs.', 'error')).finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading) return <LoadingState label="Loading audit trail..." />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><ClipboardList size={21} aria-hidden="true" />Audit Logs</h1><p className="text-sm text-[#6E6E73]">Every committed booking, assignment, sale, expense, inventory change and employment action is preserved.</p></div>
        <Button size="sm" variant="secondary" onClick={load}><RefreshCw size={14} aria-hidden="true" />Refresh</Button>
      </div>
      {logs.length === 0 ? <EmptyState icon={ClipboardList} title="No audit events yet" description="Committed business activity will appear here." /> : (
        <Card className="p-5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Complete SafiGroom audit trail</caption>
              <thead><tr className="text-left text-xs text-[#6E6E73] border-b border-black/5"><th className="pb-2 pr-4">Time</th><th className="pb-2 pr-4">Action</th><th className="pb-2 pr-4">Area</th><th className="pb-2 pr-4">Actor</th><th className="pb-2">Readable details</th></tr></thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id} className="border-b border-black/5 last:border-0 align-top">
                    <td className="py-3 pr-4 whitespace-nowrap text-xs text-[#6E6E73]">{new Date(log.createdAt).toLocaleString()}</td>
                    <td className="py-3 pr-4"><Badge tone={log.action.startsWith('status') ? 'info' : log.action === 'created' ? 'success' : 'warning'}>{log.action}</Badge></td>
                    <td className="py-3 pr-4 capitalize">{log.collection.replace('_', ' ')}</td>
                    <td className="py-3 pr-4">{log.actor}</td>
                    <td className="py-3 min-w-[260px]"><p>{log.summary}</p><p className="text-xs text-[#6E6E73] mt-1">{readableSnapshot(log.recordSnapshot)}</p></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function readableSnapshot(snapshot: Record<string, unknown>) {
  const fields = ['customerName', 'serviceName', 'staffName', 'productName', 'ticketNumber', 'totalByCurrency', 'amount', 'date', 'paymentMethod'];
  return fields.filter(field => snapshot[field] !== undefined && snapshot[field] !== null && snapshot[field] !== '').map(field => `${field.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`)}: ${typeof snapshot[field] === 'object' ? JSON.stringify(snapshot[field]) : String(snapshot[field])}`).join(' | ');
}

export default AuditLogs;
