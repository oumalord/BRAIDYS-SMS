import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

type RouteHandler = (context: { body: any; query: Record<string, string>; params: Record<string, string> }) => Promise<any>;

type StoredRecord = { id: string; collection: string; record: Record<string, any> };
type RequestContext = { accountId: string; tenantId: string; salonName: string; branchId?: string; role: string; name: string };

const connectionString = process.env.DATABASE_URL || process.env.VITE_NEON_DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to start the backend');

const sql = neon(connectionString);
let initialized: Promise<void> | undefined;
const requestContext = new AsyncLocalStorage<RequestContext | null>();
const globalCollections = new Set(['salons', 'branches', 'accounts', 'sessions']);

export function withRequestContext<T>(context: RequestContext | null, callback: () => Promise<T>) {
  return requestContext.run(context, callback);
}

export function currentContext() { return requestContext.getStore(); }

async function init(): Promise<void> {
  if (!initialized) {
    initialized = sql`
      CREATE TABLE IF NOT EXISTS app_records (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        tenant_id TEXT,
        record JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `.then(() => sql`ALTER TABLE app_records ADD COLUMN IF NOT EXISTS tenant_id TEXT`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS app_records_tenant_collection_idx ON app_records (tenant_id, collection)`)
      .then(() => sql`CREATE INDEX IF NOT EXISTS app_records_branch_idx ON app_records ((record->>'branchId'), collection)`)
      .then(() => undefined);
  }
  await initialized;
}

export const db = {
  async add(collection: string, records: Record<string, any>[]) {
    await init();
    const ids: string[] = [];
    for (const record of records) {
      const id = String(record.id || randomUUID());
      const context = currentContext();
      const tenantId = record.tenantId || (globalCollections.has(collection) ? null : context?.tenantId || null);
      const stampedRecord = globalCollections.has(collection) ? { ...record, id } : { ...record, id, tenantId, salonName: record.salonName || context?.salonName || '', branchId: record.branchId || context?.branchId || null };
      ids.push(id);
      await sql`INSERT INTO app_records (id, collection, tenant_id, record) VALUES (${id}, ${collection}, ${tenantId}, ${JSON.stringify(stampedRecord)}::jsonb)`;
    }
    return ids;
  },
  async list(collection: string, options?: { limit?: number }) {
    await init();
    const limit = Math.min(Math.max(Number(options?.limit || 100), 1), 5000);
    const context = currentContext();
    const tenantId = context?.tenantId || null;
    const branchId = context?.role === 'barber' || context?.role === 'receptionist' || context?.role === 'manager' ? context?.branchId || null : null;
    const rows = globalCollections.has(collection) || context?.role === 'admin'
      ? await sql`SELECT id, record FROM app_records WHERE collection = ${collection} ORDER BY created_at ASC LIMIT ${limit}` as StoredRecord[]
      : branchId ? await sql`SELECT id, record FROM app_records WHERE collection = ${collection} AND tenant_id = ${tenantId} AND (record->>'branchId' = ${branchId} OR record->>'branchId' IS NULL) ORDER BY created_at ASC LIMIT ${limit}` as StoredRecord[]
        : await sql`SELECT id, record FROM app_records WHERE collection = ${collection} AND tenant_id = ${tenantId} ORDER BY created_at ASC LIMIT ${limit}` as StoredRecord[];
    return { items: rows.map(row => ({ ...(row.record || {}), id: row.id })) };
  },
  async get(collection: string, ids: string[]) {
    await init();
    if (!ids.length) return [];
    const context = currentContext();
    const tenantId = context?.tenantId || null;
    const branchId = context?.role === 'barber' || context?.role === 'receptionist' || context?.role === 'manager' ? context?.branchId || null : null;
    const rows = globalCollections.has(collection) || context?.role === 'admin'
      ? await sql`SELECT id, record FROM app_records WHERE collection = ${collection} AND id = ANY(${ids})` as StoredRecord[]
      : branchId ? await sql`SELECT id, record FROM app_records WHERE collection = ${collection} AND tenant_id = ${tenantId} AND record->>'branchId' = ${branchId} AND id = ANY(${ids})` as StoredRecord[]
        : await sql`SELECT id, record FROM app_records WHERE collection = ${collection} AND tenant_id = ${tenantId} AND id = ANY(${ids})` as StoredRecord[];
    const byId = new Map(rows.map(row => [row.id, { ...(row.record || {}), id: row.id }]));
    return ids.map(id => byId.get(id) || null);
  },
  async update(collection: string, updates: { id: string; record: Record<string, any> }[]) {
    await init();
    const context = currentContext();
    const tenantId = context?.tenantId || null;
    for (const update of updates) {
      if (globalCollections.has(collection)) await sql`UPDATE app_records SET record = ${JSON.stringify({ ...update.record, id: update.id })}::jsonb WHERE collection = ${collection} AND id = ${update.id}`;
      else await sql`UPDATE app_records SET record = ${JSON.stringify({ ...update.record, id: update.id, tenantId })}::jsonb WHERE collection = ${collection} AND tenant_id = ${tenantId} AND id = ${update.id}`;
    }
    return updates.map(() => true);
  },
  async delete(collection: string, ids: string[]) {
    await init();
    if (!ids.length) return true;
    const context = currentContext();
    await sql`DELETE FROM app_records WHERE collection = ${collection} AND tenant_id = ${context?.tenantId || null} AND id = ANY(${ids})`;
    return true;
  },
};

export function json(body: unknown, status = 200) {
  return { status, body };
}

export function error(message: string, status = 500) {
  return json({ error: message }, status);
}

export function router(routes: Record<string, [RouteHandler]>) {
  return { routes };
}

const images = new Map<string, string>();
const emptyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/3X5wNwAAAABJRU5ErkJggg==';
export const ai = { imageGen: async () => ({ image: { data: emptyPng, mimeType: 'image/png' } }) };
export const storage = {
  async read(paths: string[]) { return paths.map(path => ({ content: images.get(path) || null })); },
  async write(entries: { path: string; content: string }[]) { entries.forEach(entry => images.set(entry.path, entry.content)); return entries.map(() => true); },
  async url(paths: string[]) { return paths.map(path => ({ url: images.has(path) ? `data:image/png;base64,${images.get(path)}` : '' })); },
};
