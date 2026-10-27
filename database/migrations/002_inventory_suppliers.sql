ALTER TABLE fabrics ADD COLUMN stock_qty_mm INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty_mm >= 0);

UPDATE fabrics
SET stock_qty_mm = COALESCE(
  (SELECT SUM(quantity_mm) FROM stock_movements WHERE stock_movements.fabric_id = fabrics.id),
  0
);

ALTER TABLE fabrics ADD COLUMN stock_value_minor INTEGER NOT NULL DEFAULT 0 CHECK (stock_value_minor >= 0);
UPDATE fabrics
SET stock_value_minor = ROUND(stock_qty_mm * purchase_cost_minor / 1000.0);

ALTER TABLE stock_movements ADD COLUMN movement_type TEXT NOT NULL DEFAULT 'adjustment'
  CHECK (movement_type IN ('opening', 'adjustment', 'purchase', 'sale'));
ALTER TABLE stock_movements ADD COLUMN reference TEXT NOT NULL DEFAULT '';
ALTER TABLE stock_movements ADD COLUMN authorized_user TEXT NOT NULL DEFAULT 'Legacy';
UPDATE stock_movements SET reference = reason;

CREATE INDEX stock_movements_created_idx ON stock_movements(created_at);
CREATE INDEX stock_movements_type_idx ON stock_movements(movement_type);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX suppliers_name_idx ON suppliers(name);

CREATE TABLE ledger_accounts (
  code TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense'))
);

INSERT INTO ledger_accounts (code, name, account_type) VALUES
  ('1000', 'Cash', 'asset'),
  ('1010', 'Bank', 'asset'),
  ('1200', 'Inventory', 'asset'),
  ('1300', 'Accounts Receivable', 'asset'),
  ('2100', 'Accounts Payable', 'liability'),
  ('3000', 'Opening Balance Equity', 'equity'),
  ('4000', 'Sales Revenue', 'income'),
  ('5000', 'Cost of Goods Sold', 'expense'),
  ('5100', 'Inventory Adjustments', 'expense');

CREATE TABLE ledger_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  transaction_type TEXT NOT NULL,
  reference TEXT NOT NULL,
  authorized_user TEXT NOT NULL DEFAULT 'System',
  created_at TEXT NOT NULL
);

CREATE INDEX ledger_transactions_created_idx ON ledger_transactions(created_at);

CREATE TABLE ledger_postings (
  id TEXT PRIMARY KEY NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  account_code TEXT NOT NULL REFERENCES ledger_accounts(code) ON DELETE RESTRICT,
  supplier_id TEXT REFERENCES suppliers(id) ON DELETE RESTRICT,
  debit_minor INTEGER NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  CHECK (debit_minor = 0 OR credit_minor = 0)
);

CREATE INDEX ledger_postings_account_idx ON ledger_postings(account_code);
CREATE INDEX ledger_postings_supplier_idx ON ledger_postings(supplier_id);

INSERT INTO ledger_transactions (id, transaction_type, reference, authorized_user, created_at)
SELECT
  'migration-002-opening-inventory',
  'inventory_migration_opening',
  'Opening inventory balance',
  'System migration',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE (SELECT COALESCE(SUM(stock_value_minor), 0) FROM fabrics) > 0;

INSERT INTO ledger_postings (id, transaction_id, account_code, debit_minor, credit_minor)
SELECT
  'migration-002-inventory-debit',
  'migration-002-opening-inventory',
  '1200',
  SUM(stock_value_minor),
  0
FROM fabrics
HAVING SUM(stock_value_minor) > 0;

INSERT INTO ledger_postings (id, transaction_id, account_code, debit_minor, credit_minor)
SELECT
  'migration-002-equity-credit',
  'migration-002-opening-inventory',
  '3000',
  0,
  SUM(stock_value_minor)
FROM fabrics
HAVING SUM(stock_value_minor) > 0;

CREATE TABLE supplier_purchases (
  id TEXT PRIMARY KEY NOT NULL,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  bill_number TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (supplier_id, bill_number)
);

CREATE INDEX supplier_purchases_supplier_idx ON supplier_purchases(supplier_id, created_at);

CREATE TABLE supplier_purchase_items (
  id TEXT PRIMARY KEY NOT NULL,
  purchase_id TEXT NOT NULL REFERENCES supplier_purchases(id) ON DELETE RESTRICT,
  fabric_id TEXT NOT NULL REFERENCES fabrics(id) ON DELETE RESTRICT,
  quantity_mm INTEGER NOT NULL CHECK (quantity_mm > 0),
  unit_cost_minor INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (line_total_minor >= 0)
);

CREATE TABLE supplier_payments (
  id TEXT PRIMARY KEY NOT NULL,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  payment_number TEXT NOT NULL UNIQUE,
  account_code TEXT NOT NULL REFERENCES ledger_accounts(code) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX supplier_payments_supplier_idx ON supplier_payments(supplier_id, created_at);
