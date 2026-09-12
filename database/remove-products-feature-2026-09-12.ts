import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);

const [{ count: productsCount }] = await sql`SELECT COUNT(*)::int AS count FROM app_records WHERE collection = 'products'` as { count: number }[];
const [{ count: stockMovementsCount }] = await sql`SELECT COUNT(*)::int AS count FROM app_records WHERE collection = 'stock_movements'` as { count: number }[];

await sql`DROP TRIGGER IF EXISTS app_records_no_delete ON app_records`;
await sql`DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records`;

await sql`DELETE FROM app_records WHERE collection = 'products'`;
await sql`DELETE FROM app_records WHERE collection = 'stock_movements'`;

await sql`CREATE TRIGGER app_records_no_delete BEFORE DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete()`;
await sql`CREATE TRIGGER app_records_no_committed_update BEFORE UPDATE ON app_records FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update()`;

console.log(`Removed the products feature: deleted ${productsCount} product record(s) and ${stockMovementsCount} stock movement record(s).`);
