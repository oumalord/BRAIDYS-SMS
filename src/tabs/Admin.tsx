import { useEffect, useState } from 'react';
import { Building2, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { AdminApi } from '../lib/api';
import { Badge, Button, Card, Field, Input, LoadingState, Modal, Select, toast } from '../components/ui';

type Directory = { salons: any[]; branches: any[]; accounts: any[] };

function Admin() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [loadError, setLoadError] = useState('');
  const [showSalon, setShowSalon] = useState(false);
  const [showBranch, setShowBranch] = useState(false);
  const [salon, setSalon] = useState({ name: '', branchName: 'Main Branch', ownerName: '', ownerEmail: '', ownerPhone: '', ownerPassword: '' });
  const [branch, setBranch] = useState({ salonId: '', name: '', address: '' });
  const [reset, setReset] = useState<{ id: string; email: string } | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const load = () => {
    setLoadError('');
    AdminApi.directory().then(setDirectory).catch((cause: any) => {
      const message = cause?.name === 'AbortError' ? 'The directory request timed out.' : cause?.message || 'Could not load admin directory.';
      setLoadError(message);
      toast(message, 'error');
    });
  };
  useEffect(() => { void load(); }, []);
  if (loadError) return <div className="flex flex-col items-center justify-center py-16 text-center"><p className="font-medium">Could not load the platform directory.</p><p className="mt-1 text-sm text-[#6E6E73]">{loadError}</p><Button className="mt-4" onClick={load}><RefreshCw size={14} aria-hidden="true" />Try again</Button></div>;
  if (!directory) return <LoadingState label="Loading platform directory..." />;

  const createSalon = async () => {
    if (salon.ownerPassword.length < 8) { toast('Owner password must be at least 8 characters.', 'error'); return; }
    try { await AdminApi.createSalon(salon); toast('Salon and owner account created. Credentials were emailed.', 'success'); setShowSalon(false); setSalon({ name: '', branchName: 'Main Branch', ownerName: '', ownerEmail: '', ownerPhone: '', ownerPassword: '' }); load(); }
    catch (cause: any) { toast(cause?.message || 'Could not create salon.', 'error'); }
  };
  const createBranch = async () => { try { await AdminApi.createBranch(branch); toast('Branch created.', 'success'); setShowBranch(false); setBranch({ salonId: '', name: '', address: '' }); load(); } catch (cause: any) { toast(cause?.message || 'Could not create branch.', 'error'); } };
  const resetPassword = async () => { if (newPassword.length < 8 || !reset) { toast('Password must be at least 8 characters.', 'error'); return; } try { await AdminApi.resetPassword(reset.id, newPassword); toast('Password reset and emailed.', 'success'); setReset(null); setNewPassword(''); } catch (cause: any) { toast(cause?.message || 'Could not reset password.', 'error'); } };

  return <div className="space-y-6"><div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Building2 size={21} aria-hidden="true" />Platform Administration</h1><p className="text-sm text-[#6E6E73]">Manage salons, branches, owners and employee access.</p></div><div className="flex gap-2"><Button variant="secondary" size="sm" onClick={load}><RefreshCw size={14} aria-hidden="true" />Refresh</Button><Button size="sm" onClick={() => setShowSalon(true)}><Plus size={14} aria-hidden="true" />Create salon</Button></div></div>
    <div className="grid sm:grid-cols-3 gap-4"><Card className="p-5"><p className="text-xs text-[#6E6E73]">Salons</p><p className="text-2xl font-semibold">{directory.salons.length}</p></Card><Card className="p-5"><p className="text-xs text-[#6E6E73]">Branches</p><p className="text-2xl font-semibold">{directory.branches.length}</p></Card><Card className="p-5"><p className="text-xs text-[#6E6E73]">Accounts</p><p className="text-2xl font-semibold">{directory.accounts.length}</p></Card></div>
    <Card className="p-5"><div className="flex items-center justify-between mb-4"><h2 className="font-semibold">Salon directory</h2><Button size="sm" variant="secondary" onClick={() => setShowBranch(true)} disabled={!directory.salons.length}><Plus size={14} aria-hidden="true" />Add branch</Button></div><div className="space-y-3">{directory.salons.map(item => <div key={item.id} className="border-b border-black/5 pb-3 last:border-0 flex items-center justify-between gap-3"><div><p className="font-medium">{item.name}</p><p className="text-xs text-[#6E6E73]">{directory.branches.filter(branchItem => branchItem.salonId === item.id).map(branchItem => branchItem.name).join(', ') || 'No branches'}</p></div><Badge tone={item.status === 'active' ? 'success' : 'neutral'}>{item.status}</Badge></div>)}{!directory.salons.length && <p className="text-sm text-[#6E6E73]">No salons yet. Create the first salon above.</p>}</div></Card>
    <Card className="p-5"><h2 className="font-semibold mb-4">Account access</h2><div className="space-y-3">{directory.accounts.filter(account => account.role !== 'admin').map(account => <div key={account.id} className="border-b border-black/5 pb-3 last:border-0 flex items-center justify-between gap-3"><div><p className="font-medium">{account.name}</p><p className="text-xs text-[#6E6E73]">{account.email} · {account.salonName} · {account.role}</p></div><Button size="sm" variant="secondary" onClick={() => setReset({ id: account.id, email: account.email })}><KeyRound size={14} aria-hidden="true" />Reset password</Button></div>)}</div></Card>
    {showSalon && <Modal title="Create salon and owner" onClose={() => setShowSalon(false)} footer={<><Button variant="secondary" onClick={() => setShowSalon(false)}>Cancel</Button><Button onClick={createSalon}>Create salon</Button></>}><div className="space-y-4"><Field label="Salon name" htmlFor="admin-salon-name"><Input id="admin-salon-name" value={salon.name} onChange={e => setSalon({ ...salon, name: e.target.value })} placeholder="AMALIA SALON" /></Field><Field label="First branch" htmlFor="admin-branch-name"><Input id="admin-branch-name" value={salon.branchName} onChange={e => setSalon({ ...salon, branchName: e.target.value })} /></Field><Field label="Owner name" htmlFor="admin-owner-name"><Input id="admin-owner-name" value={salon.ownerName} onChange={e => setSalon({ ...salon, ownerName: e.target.value })} /></Field><Field label="Owner email" htmlFor="admin-owner-email"><Input id="admin-owner-email" type="email" value={salon.ownerEmail} onChange={e => setSalon({ ...salon, ownerEmail: e.target.value })} /></Field><Field label="Owner phone" htmlFor="admin-owner-phone"><Input id="admin-owner-phone" value={salon.ownerPhone} onChange={e => setSalon({ ...salon, ownerPhone: e.target.value })} /></Field><Field label="Temporary owner password" htmlFor="admin-owner-password"><Input id="admin-owner-password" type="password" value={salon.ownerPassword} onChange={e => setSalon({ ...salon, ownerPassword: e.target.value })} /></Field></div></Modal>}
    {showBranch && <Modal title="Add branch" onClose={() => setShowBranch(false)} footer={<><Button variant="secondary" onClick={() => setShowBranch(false)}>Cancel</Button><Button onClick={createBranch}>Add branch</Button></>}><div className="space-y-4"><Field label="Salon" htmlFor="admin-branch-salon"><Select id="admin-branch-salon" value={branch.salonId} onChange={e => setBranch({ ...branch, salonId: e.target.value })}><option value="">Choose salon</option>{directory.salons.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></Field><Field label="Branch name" htmlFor="admin-new-branch"><Input id="admin-new-branch" value={branch.name} onChange={e => setBranch({ ...branch, name: e.target.value })} /></Field><Field label="Address" htmlFor="admin-branch-address"><Input id="admin-branch-address" value={branch.address} onChange={e => setBranch({ ...branch, address: e.target.value })} /></Field></div></Modal>}
    {reset && <Modal title="Reset account password" onClose={() => setReset(null)} footer={<><Button variant="secondary" onClick={() => setReset(null)}>Cancel</Button><Button onClick={resetPassword}>Reset and email</Button></>}><p className="text-sm text-[#6E6E73] mb-4">A temporary password will be emailed to {reset.email}.</p><Field label="New temporary password" htmlFor="admin-reset-password"><Input id="admin-reset-password" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></Field></Modal>}
  </div>;
}
export default Admin;
