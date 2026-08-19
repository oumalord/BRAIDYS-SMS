-- SafiGroom OS Neon bootstrap
-- Run this script in the Neon SQL Editor before starting the API.
-- The application stores flexible business records as JSONB while keeping
-- collection and id indexed for fast operational reads.

CREATE TABLE IF NOT EXISTS app_records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS app_records_collection_idx
  ON app_records (collection);

CREATE INDEX IF NOT EXISTS app_records_collection_created_idx
  ON app_records (collection, created_at DESC);

CREATE INDEX IF NOT EXISTS app_records_record_gin_idx
  ON app_records USING GIN (record);

ALTER TABLE app_records ADD COLUMN IF NOT EXISTS tenant_id TEXT;
CREATE INDEX IF NOT EXISTS app_records_tenant_collection_idx ON app_records (tenant_id, collection);
CREATE INDEX IF NOT EXISTS app_records_branch_idx ON app_records ((record->>'branchId'), collection);

-- Existing demo data belongs to the first example salon.
DROP TRIGGER IF EXISTS app_records_no_delete ON app_records;
DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records;
UPDATE app_records
SET tenant_id = 'salon-amalia', record = record || jsonb_build_object('tenantId', 'salon-amalia', 'salonName', 'AMALIA SALON')
WHERE tenant_id IS NULL AND collection NOT IN ('salons', 'branches', 'accounts', 'sessions');

CREATE OR REPLACE VIEW salon_directory AS SELECT id, record FROM app_records WHERE collection = 'salons';
CREATE OR REPLACE VIEW branch_directory AS SELECT id, record FROM app_records WHERE collection = 'branches';
CREATE OR REPLACE VIEW salon_accounts AS SELECT id, record FROM app_records WHERE collection = 'accounts';
CREATE OR REPLACE VIEW staff_directory AS
SELECT id, record->>'name' AS name, record->>'role' AS role, record->>'phone' AS phone, record->>'accountEmail' AS account_email, record->>'employmentStatus' AS employment_status, record->>'salonName' AS salon_name, record->>'branchName' AS branch_name
FROM app_records WHERE collection = 'staff';
CREATE OR REPLACE VIEW customer_directory AS
SELECT id, record->>'name' AS name, record->>'phone' AS phone, record->>'email' AS email, record->>'membershipTier' AS membership_tier, record->>'salonName' AS salon_name
FROM app_records WHERE collection = 'customers';
CREATE OR REPLACE VIEW appointment_directory AS
SELECT id, record->>'customerName' AS customer_name, record->>'serviceName' AS service_name, record->>'staffName' AS employee_name, record->>'date' AS appointment_date, record->>'time' AS appointment_time, record->>'status' AS status, record->>'ticketNumber' AS ticket_number, record->>'salonName' AS salon_name
FROM app_records WHERE collection = 'appointments';

-- SafiGroom collections used by the API. The JSONB record keeps the app
-- flexible while these views make every operational table easy to query.
CREATE OR REPLACE VIEW salon_staff AS SELECT id, record FROM app_records WHERE collection = 'staff';
CREATE OR REPLACE VIEW salon_services AS SELECT id, record FROM app_records WHERE collection = 'services';
CREATE OR REPLACE VIEW salon_customers AS SELECT id, record FROM app_records WHERE collection = 'customers';
CREATE OR REPLACE VIEW salon_appointments AS SELECT id, record FROM app_records WHERE collection = 'appointments';
CREATE OR REPLACE VIEW salon_queue AS SELECT id, record FROM app_records WHERE collection = 'queue';
CREATE OR REPLACE VIEW salon_orders AS SELECT id, record FROM app_records WHERE collection = 'orders';
CREATE OR REPLACE VIEW salon_products AS SELECT id, record FROM app_records WHERE collection = 'products';
CREATE OR REPLACE VIEW salon_expenses AS SELECT id, record FROM app_records WHERE collection = 'expenses';
CREATE OR REPLACE VIEW salon_membership_plans AS SELECT id, record FROM app_records WHERE collection = 'membership_plans';
CREATE OR REPLACE VIEW salon_promotions AS SELECT id, record FROM app_records WHERE collection = 'promotions';
CREATE OR REPLACE VIEW salon_reviews AS SELECT id, record FROM app_records WHERE collection = 'reviews';
CREATE OR REPLACE VIEW salon_messages AS SELECT id, record FROM app_records WHERE collection = 'messages';
CREATE OR REPLACE VIEW salon_mpesa_transactions AS SELECT id, record FROM app_records WHERE collection = 'mpesa_transactions';
CREATE OR REPLACE VIEW salon_notifications AS SELECT id, record FROM app_records WHERE collection = 'notifications';
CREATE OR REPLACE VIEW salon_audit_logs AS SELECT id, record FROM app_records WHERE collection = 'audit_logs';
CREATE OR REPLACE VIEW salon_stock_movements AS SELECT id, record FROM app_records WHERE collection = 'stock_movements';

CREATE OR REPLACE FUNCTION prevent_safigroom_record_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SafiGroom records are append-only and cannot be deleted';
END;
$$;

DROP TRIGGER IF EXISTS app_records_no_delete ON app_records;
CREATE TRIGGER app_records_no_delete
BEFORE DELETE ON app_records
FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete();

CREATE OR REPLACE FUNCTION prevent_safigroom_committed_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.collection IN ('orders', 'expenses', 'messages', 'audit_logs', 'notifications', 'stock_movements') THEN
    RAISE EXCEPTION 'Committed SafiGroom records cannot be edited';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records;
CREATE TRIGGER app_records_no_committed_update
BEFORE UPDATE ON app_records
FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update();

-- Optional operational views for reporting and SQL inspection.
CREATE OR REPLACE VIEW salon_inventory AS
SELECT id, record
FROM app_records
WHERE collection = 'products';

-- One-time data policy migration: remove salary fields and force the
-- commission-only employment model for existing staff records.
UPDATE app_records
SET record = (record - 'monthlySalary') || jsonb_build_object('commissionPct', 40, 'employmentStatus', COALESCE(record->>'employmentStatus', 'active'))
WHERE collection = 'staff';

DROP TRIGGER IF EXISTS app_records_no_delete ON app_records;
CREATE TRIGGER app_records_no_delete
BEFORE DELETE ON app_records
FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_record_delete();

DROP TRIGGER IF EXISTS app_records_no_committed_update ON app_records;
CREATE TRIGGER app_records_no_committed_update
BEFORE UPDATE ON app_records
FOR EACH ROW EXECUTE FUNCTION prevent_safigroom_committed_update();
