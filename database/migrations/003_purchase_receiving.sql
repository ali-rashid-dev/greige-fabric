ALTER TABLE supplier_purchases ADD COLUMN purchase_date TEXT NOT NULL DEFAULT '';
ALTER TABLE supplier_purchases ADD COLUMN additional_cost_minor INTEGER NOT NULL DEFAULT 0
  CHECK (additional_cost_minor >= 0);
ALTER TABLE supplier_purchases ADD COLUMN additional_cost_description TEXT NOT NULL DEFAULT '';
ALTER TABLE supplier_purchases ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'credit'
  CHECK (payment_mode IN ('credit', 'cash', 'bank'));
ALTER TABLE supplier_purchases ADD COLUMN paid_minor INTEGER NOT NULL DEFAULT 0
  CHECK (paid_minor >= 0 AND paid_minor <= total_minor);
UPDATE supplier_purchases SET purchase_date = substr(created_at, 1, 10);

ALTER TABLE supplier_purchase_items ADD COLUMN allocated_cost_minor INTEGER NOT NULL DEFAULT 0
  CHECK (allocated_cost_minor >= 0);

ALTER TABLE supplier_payments ADD COLUMN purchase_id TEXT
  REFERENCES supplier_purchases(id) ON DELETE RESTRICT;
CREATE INDEX supplier_payments_purchase_idx ON supplier_payments(purchase_id);
