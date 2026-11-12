-- Vendors can be edited and deactivated. Inactive vendors are invisible to the policy engine,
-- so an invoice from one is treated as an unknown vendor and waits for a signature.
ALTER TABLE vendors ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE vendors ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
