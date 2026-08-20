import { useEffect, useState } from 'react';
import { Plus, Package as PackageIcon, AlertTriangle } from 'lucide-react';
import { Card, Button, Badge, Modal, Field, Input, Select, EmptyState, LoadingState, toast } from '../components/ui';
import { ProductsApi, fmtKES } from '../lib/api';
import type { Product } from '../types';

function Inventory() {
  const categories = ['Hair', 'Oils', 'Shampoo', 'Conditioner', 'Hair Treatment', 'Hair Color', 'Braids', 'Wigs', 'Extensions', 'Styling Products', 'Skin Care', 'Nail Care', 'Makeup', 'Barber Supplies', 'Tools & Equipment', 'Cleaning Supplies', 'Retail Products', 'Other'];
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', category: 'Hair', color: '', price: 0, cost: 0, stock: 0, lowStockThreshold: 5, unit: 'pcs' });

  const load = () => { ProductsApi.list().then(setProducts).catch(() => toast('Could not load inventory.', 'error')).finally(() => setLoading(false)); };
  useEffect(load, []);

  const addProduct = async () => {
    if (!form.name.trim()) { toast('Product name is required.', 'error'); return; }
    await ProductsApi.create(form);
    toast('Product added.', 'success');
    setOpen(false);
    setForm({ name: '', category: 'Hair', color: '', price: 0, cost: 0, stock: 0, lowStockThreshold: 5, unit: 'pcs' });
    load();
  };

  const adjustStock = async (p: Product, delta: number) => {
    const newStock = Math.max(0, p.stock + delta);
    await ProductsApi.update(p.id, { stock: newStock });
    load();
  };

  if (loading) return <LoadingState label="Loading inventory…" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-semibold tracking-tight">Inventory</h1><p className="text-sm text-[#6E6E73]">{products.length} products tracked</p></div>
        <Button onClick={() => setOpen(true)}><Plus size={16} aria-hidden="true" />Add Product</Button>
      </div>

      {products.length === 0 ? <EmptyState icon={PackageIcon} title="No products yet" description="Add products to start tracking stock." /> : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {products.map(p => {
            const low = p.stock <= p.lowStockThreshold;
            const pct = Math.min(100, (p.stock / Math.max(1, p.lowStockThreshold * 3)) * 100);
            return (
              <Card key={p.id} className="p-5">
                <div className="flex items-start justify-between mb-2">
                  <div><p className="font-medium">{p.name}</p><p className="text-xs text-[#6E6E73]">{p.category}{p.color ? ` · ${p.color}` : ''}</p></div>
                  {low && <Badge tone="warning"><AlertTriangle size={11} aria-hidden="true" />Low</Badge>}
                </div>
                <p className="text-sm text-[#6E6E73] mb-1">{p.stock} {p.unit} in stock · sells for {fmtKES(p.price)}</p>
                <div className="h-1.5 rounded-full bg-black/5 overflow-hidden mb-3" role="img" aria-label={`Stock level: ${p.stock} of recommended ${p.lowStockThreshold * 3} ${p.unit}`}>
                  <div className={`h-full rounded-full ${low ? 'bg-[#FF9500]' : 'bg-[#34C759]'}`} style={{ width: `${pct}%` }} />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => adjustStock(p, -1)}>-1</Button>
                  <Button size="sm" variant="secondary" onClick={() => adjustStock(p, 1)}>+1</Button>
                  <Button size="sm" variant="secondary" onClick={() => adjustStock(p, 10)}>+10</Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {open && (
        <Modal title="Add Product" onClose={() => setOpen(false)} footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={addProduct}>Add Product</Button>
        </>}>
          <div className="space-y-4">
            <Field label="Product name" htmlFor="p-name"><Input id="p-name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Category" htmlFor="p-cat"><Select id="p-cat" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>{categories.map(category => <option key={category} value={category}>{category}</option>)}</Select></Field>
            <Field label="Color" htmlFor="p-color"><Input id="p-color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} placeholder="e.g. Black, Brown, Blonde, Natural" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Sell price (KES)" htmlFor="p-price"><Input id="p-price" type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: Number(e.target.value) }))} /></Field>
              <Field label="Cost price (KES)" htmlFor="p-cost"><Input id="p-cost" type="number" value={form.cost} onChange={e => setForm(f => ({ ...f, cost: Number(e.target.value) }))} /></Field>
              <Field label="Starting stock" htmlFor="p-stock"><Input id="p-stock" type="number" value={form.stock} onChange={e => setForm(f => ({ ...f, stock: Number(e.target.value) }))} /></Field>
              <Field label="Low stock alert at" htmlFor="p-threshold"><Input id="p-threshold" type="number" value={form.lowStockThreshold} onChange={e => setForm(f => ({ ...f, lowStockThreshold: Number(e.target.value) }))} /></Field>
            </div>
            <Field label="Unit" htmlFor="p-unit">
              <Select id="p-unit" value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))}>
                <option value="pcs">pcs</option><option value="ml">ml</option><option value="bottle">bottle</option><option value="g">g</option>
              </Select>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default Inventory;
