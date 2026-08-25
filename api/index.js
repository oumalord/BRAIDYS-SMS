import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const server = require('./server.cjs');

export default server.app;