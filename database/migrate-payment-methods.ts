import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
await sql`CREATE INDEX IF NOT EXISTS app_records_payment_method_idx ON app_records ((record->>'paymentMethod')) WHERE collection = 'orders'`;
console.log('Payment method index is ready. Existing orders remain unchanged.');
