import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const loaded = require('../../api/server.cjs');
const app = loaded.default || loaded.app || loaded;
export default function handler(req, res) {
  req.url = `/api/public/salons${req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  return app(req, res);
}
