import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const sql = neon(databaseUrl);
await sql`
  CREATE OR REPLACE FUNCTION prevent_safigroom_committed_update()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF OLD.collection IN ('orders', 'expenses', 'messages', 'audit_logs', 'notifications', 'stock_movements')
      AND NOT (NEW.record ? 'deletedAt' AND NOT (OLD.record ? 'deletedAt')) THEN
      RAISE EXCEPTION 'Committed SafiGroom records cannot be edited';
    END IF;
    RETURN NEW;
  END;
  $$;
`;
console.log('Committed records allow a one-time soft-delete marker while remaining immutable otherwise.');