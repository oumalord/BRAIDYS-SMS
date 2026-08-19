import 'dotenv/config';
import fs from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
const source = await fs.readFile(new URL('./neon.sql', import.meta.url), 'utf8');
const statements: string[] = [];
let current = '';
let inDollarQuote = false;
for (const line of source.split(/\r?\n/)) {
  current += `${line}\n`;
  if (line.includes('$$')) inDollarQuote = !inDollarQuote;
  if (!inDollarQuote && line.trimEnd().endsWith(';')) {
    const statement = current.replace(/--[^\r\n]*/g, '').trim();
    if (statement) statements.push(statement);
    current = '';
  }
}
const remaining = current.replace(/--[^\r\n]*/g, '').trim();
if (remaining) statements.push(remaining);

for (const statement of statements) {
  await sql.query(statement, []);
}

console.log(`Applied ${statements.length} Neon bootstrap statements.`);
