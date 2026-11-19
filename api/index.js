import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const loaded = require('./server.cjs');
const app = loaded.default || loaded.app || loaded;

export default function handler(req, res) {
  if (typeof app !== 'function') {
    res.status(500).json({ error: 'Bundled API server is not callable.' });
    return;
  }
  const incomingUrl = new URL(req.url || '/', 'http://localhost');
  const apiPath = incomingUrl.searchParams.get('__api_path');
  if (apiPath !== null) {
    incomingUrl.searchParams.delete('__api_path');
    const query = incomingUrl.searchParams.toString();
    req.url = `/api/${apiPath.replace(/^\/+/, '')}${query ? `?${query}` : ''}`;
  }
  return app(req, res);
}