import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const loaded = require('./server.cjs');
const app = loaded.default || loaded.app || loaded;

export default function handler(req, res) {
  if (typeof app !== 'function') {
    res.status(500).json({ error: 'Bundled API server is not callable.' });
    return;
  }
  return app(req, res);
}