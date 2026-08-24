import 'dotenv/config';
import express from 'express';
import { ensurePlatformAdmin, handler } from './index';
import { db, withRequestContext } from './runtime';
import { createHash } from 'node:crypto';

function normalizeRole(role: unknown) {
  const value = String(role || '').trim().toLowerCase();
  if (['owner', 'manager', 'receptionist', 'barber', 'customer', 'admin'].includes(value)) return value;
  if (value.includes('reception')) return 'receptionist';
  if (value.includes('manager')) return 'manager';
  return 'barber';
}

const app = express();
const port = Number(process.env.PORT || 8787);
app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  const origin = String(request.headers.origin || '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) response.header('Access-Control-Allow-Origin', origin);
  response.header('Access-Control-Allow-Headers', 'Content-Type');
  response.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  next();
});

async function resolveContext(request: any) {
  const header = String(request.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const [session] = await db.get('sessions', [tokenHash]);
  if (!session || session.expiresAt < Date.now()) return null;
  const [account] = await db.get('accounts', [session.accountId]);
  if (!account || account.status !== 'active') return null;
  let branchId = account.branchId;
  const role = normalizeRole(account.role);
  const hasBranchSelection = Object.prototype.hasOwnProperty.call(request.headers, 'x-branch-id');
  if ((role === 'owner' || role === 'manager' || role === 'admin') && hasBranchSelection) {
    const requestedBranchId = String(request.headers['x-branch-id'] || '');
    if (!requestedBranchId) branchId = undefined;
    else {
      const [branch] = await db.get('branches', [requestedBranchId]);
      if (branch && (role === 'admin' || branch.salonId === account.tenantId) && branch.status === 'active') branchId = branch.id;
    }
  }
  return { accountId: account.id, tenantId: account.tenantId, salonName: account.salonName, branchId, role, name: account.name, staffId: account.staffId };
}

const publicRoutes = new Set(['/api/_healthcheck', '/api/public/salons', '/api/public/branches', '/api/auth/login', '/api/auth/signup', '/api/auth/demo', '/api/mpesa/callback', '/api/payroll/timeout', '/api/payroll/result']);

for (const [definition, [routeHandler]] of Object.entries(handler.routes)) {
  const [method, path] = definition.split(' ');
  const pattern = new RegExp(`^${path.replace(/:[^/]+/g, '([^/]+)')}$`);
  const parameterNames = [...path.matchAll(/:([^/]+)/g)].map(match => match[1]);
  (app as any)[method.toLowerCase()](new RegExp(pattern), async (request: any, response: any) => {
    const match = request.path.match(pattern);
    const params = Object.fromEntries(parameterNames.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
    try {
      const context = await resolveContext(request);
      if (!publicRoutes.has(request.path) && !context) return response.status(401).json({ error: 'Please log in.' });
      const result = await withRequestContext(context, () => routeHandler({ body: request.body, query: request.query, params }));
      response.status(result?.status || 200).json(result?.body ?? result);
    } catch (cause) {
      console.error(cause);
      response.status(500).json({ error: cause instanceof Error ? cause.message : 'Internal server error' });
    }
  });
}

ensurePlatformAdmin().then(() => {
  app.listen(port, () => console.log(`SafiGroom API listening on http://localhost:${port}`));
}).catch(cause => {
  console.error('Could not initialize platform admin account', cause);
  process.exitCode = 1;
});
