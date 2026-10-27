ALTER TABLE invoice_items ADD COLUMN cost_of_goods_sold_minor INTEGER NOT NULL DEFAULT 0
  CHECK (cost_of_goods_sold_minor >= 0);
ALTER TABLE invoices ADD COLUMN returned_minor INTEGER NOT NULL DEFAULT 0
  CHECK (returned_minor >= 0 AND returned_minor <= total_minor);

WITH invoice_totals AS (
  SELECT i.id,
    COALESCE((
      SELECT SUM(p.debit_minor)
      FROM ledger_postings p
      JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE t.transaction_type = 'sale'
        AND t.reference = i.invoice_number
        AND p.account_code = '5000'
    ), 0) AS total_cost_minor,
    SUM(ii.line_total_minor) AS total_sales_minor
  FROM invoices i
  JOIN invoice_items ii ON ii.invoice_id = i.id
  GROUP BY i.id
), cumulative_lines AS (
  SELECT ii.rowid AS item_rowid,
    ii.line_total_minor,
    SUM(ii.line_total_minor) OVER (
      PARTITION BY ii.invoice_id ORDER BY ii.rowid ROWS UNBOUNDED PRECEDING
    ) AS cumulative_sales_minor,
    totals.total_cost_minor,
    totals.total_sales_minor
  FROM invoice_items ii
  JOIN invoice_totals totals ON totals.id = ii.invoice_id
)
UPDATE invoice_items
SET cost_of_goods_sold_minor = (
  SELECT
    CAST((total_cost_minor * cumulative_sales_minor + total_sales_minor / 2) / total_sales_minor AS INTEGER)
    - CAST((total_cost_minor * (cumulative_sales_minor - line_total_minor) + total_sales_minor / 2) / total_sales_minor AS INTEGER)
  FROM cumulative_lines
  WHERE item_rowid = invoice_items.rowid
)
WHERE EXISTS (
  SELECT 1 FROM cumulative_lines
  WHERE item_rowid = invoice_items.rowid AND total_sales_minor > 0
);

CREATE TABLE sales_returns (
  id TEXT PRIMARY KEY NOT NULL,
  return_number TEXT NOT NULL UNIQUE,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
  settlement_type TEXT NOT NULL CHECK (settlement_type IN ('refund', 'customer_credit')),
  payment_account_code TEXT REFERENCES ledger_accounts(code) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  receivable_minor INTEGER NOT NULL DEFAULT 0 CHECK (receivable_minor >= 0),
  advance_minor INTEGER NOT NULL DEFAULT 0 CHECK (advance_minor >= 0),
  created_at TEXT NOT NULL,
  authorized_user TEXT NOT NULL,
  reversed_at TEXT,
  reversal_reason TEXT NOT NULL DEFAULT '',
  CHECK (
    (settlement_type = 'refund' AND payment_account_code IS NOT NULL AND receivable_minor = 0 AND advance_minor = 0)
    OR (settlement_type = 'customer_credit' AND payment_account_code IS NULL
        AND receivable_minor + advance_minor = total_minor AND customer_id IS NOT NULL)
  )
);

CREATE TABLE sales_return_items (
  id TEXT PRIMARY KEY NOT NULL,
  sales_return_id TEXT NOT NULL REFERENCES sales_returns(id) ON DELETE RESTRICT,
  invoice_item_id TEXT NOT NULL REFERENCES invoice_items(id) ON DELETE RESTRICT,
  quantity_mm INTEGER NOT NULL CHECK (quantity_mm > 0),
  saleable INTEGER NOT NULL CHECK (saleable IN (0, 1)),
  returned_minor INTEGER NOT NULL CHECK (returned_minor >= 0),
  cost_minor INTEGER NOT NULL CHECK (cost_minor >= 0)
);

CREATE INDEX sales_returns_invoice_idx ON sales_returns(invoice_id);
CREATE INDEX sales_return_items_source_idx ON sales_return_items(invoice_item_id);

CREATE TRIGGER sales_returns_immutable_update
BEFORE UPDATE ON sales_returns
WHEN NOT (
  NEW.id IS OLD.id
  AND NEW.return_number IS OLD.return_number
  AND NEW.invoice_id IS OLD.invoice_id
  AND NEW.customer_id IS OLD.customer_id
  AND NEW.settlement_type IS OLD.settlement_type
  AND NEW.payment_account_code IS OLD.payment_account_code
  AND NEW.reason IS OLD.reason
  AND NEW.total_minor IS OLD.total_minor
  AND NEW.receivable_minor IS OLD.receivable_minor
  AND NEW.advance_minor IS OLD.advance_minor
  AND NEW.created_at IS OLD.created_at
  AND NEW.authorized_user IS OLD.authorized_user
  AND (
    (NEW.reversed_at IS OLD.reversed_at AND NEW.reversal_reason IS OLD.reversal_reason)
    OR (OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL AND NEW.reversal_reason <> '')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Sales return records are immutable except for one reversal.');
END;

CREATE TRIGGER sales_returns_immutable_delete
BEFORE DELETE ON sales_returns
BEGIN
  SELECT RAISE(ABORT, 'Sales return records cannot be deleted.');
END;

CREATE TRIGGER sales_return_items_immutable_update
BEFORE UPDATE ON sales_return_items
BEGIN
  SELECT RAISE(ABORT, 'Sales return lines are immutable.');
END;

CREATE TRIGGER sales_return_items_immutable_delete
BEFORE DELETE ON sales_return_items
BEGIN
  SELECT RAISE(ABORT, 'Sales return lines cannot be deleted.');
END;

CREATE TABLE purchase_returns (
  id TEXT PRIMARY KEY NOT NULL,
  return_number TEXT NOT NULL UNIQUE,
  purchase_id TEXT NOT NULL REFERENCES supplier_purchases(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  settlement_type TEXT NOT NULL CHECK (settlement_type IN ('supplier_credit', 'refund')),
  payment_account_code TEXT REFERENCES ledger_accounts(code) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  total_minor INTEGER NOT NULL CHECK (total_minor >= 0),
  created_at TEXT NOT NULL,
  authorized_user TEXT NOT NULL,
  reversed_at TEXT,
  reversal_reason TEXT NOT NULL DEFAULT '',
  CHECK (
    (settlement_type = 'refund' AND payment_account_code IS NOT NULL)
    OR (settlement_type = 'supplier_credit' AND payment_account_code IS NULL)
  )
);

CREATE TABLE purchase_return_items (
  id TEXT PRIMARY KEY NOT NULL,
  purchase_return_id TEXT NOT NULL REFERENCES purchase_returns(id) ON DELETE RESTRICT,
  purchase_item_id TEXT NOT NULL REFERENCES supplier_purchase_items(id) ON DELETE RESTRICT,
  quantity_mm INTEGER NOT NULL CHECK (quantity_mm > 0),
  value_minor INTEGER NOT NULL CHECK (value_minor >= 0)
);

CREATE INDEX purchase_returns_purchase_idx ON purchase_returns(purchase_id);
CREATE INDEX purchase_return_items_source_idx ON purchase_return_items(purchase_item_id);

CREATE TRIGGER purchase_returns_immutable_update
BEFORE UPDATE ON purchase_returns
WHEN NOT (
  NEW.id IS OLD.id
  AND NEW.return_number IS OLD.return_number
  AND NEW.purchase_id IS OLD.purchase_id
  AND NEW.supplier_id IS OLD.supplier_id
  AND NEW.settlement_type IS OLD.settlement_type
  AND NEW.payment_account_code IS OLD.payment_account_code
  AND NEW.reason IS OLD.reason
  AND NEW.total_minor IS OLD.total_minor
  AND NEW.created_at IS OLD.created_at
  AND NEW.authorized_user IS OLD.authorized_user
  AND (
    (NEW.reversed_at IS OLD.reversed_at AND NEW.reversal_reason IS OLD.reversal_reason)
    OR (OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL AND NEW.reversal_reason <> '')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Purchase return records are immutable except for one reversal.');
END;

CREATE TRIGGER purchase_returns_immutable_delete
BEFORE DELETE ON purchase_returns
BEGIN
  SELECT RAISE(ABORT, 'Purchase return records cannot be deleted.');
END;

CREATE TRIGGER purchase_return_items_immutable_update
BEFORE UPDATE ON purchase_return_items
BEGIN
  SELECT RAISE(ABORT, 'Purchase return lines are immutable.');
END;

CREATE TRIGGER purchase_return_items_immutable_delete
BEFORE DELETE ON purchase_return_items
BEGIN
  SELECT RAISE(ABORT, 'Purchase return lines cannot be deleted.');
END;

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);

CREATE TRIGGER audit_log_immutable_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'Audit log records are immutable.');
END;

CREATE TRIGGER audit_log_immutable_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'Audit log records are immutable.');
END;

CREATE TABLE stock_movements_new (
  id TEXT PRIMARY KEY NOT NULL,
  fabric_id TEXT NOT NULL REFERENCES fabrics(id) ON DELETE RESTRICT,
  quantity_mm INTEGER NOT NULL CHECK (quantity_mm <> 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  movement_type TEXT NOT NULL DEFAULT 'adjustment'
    CHECK (movement_type IN ('opening', 'adjustment', 'purchase', 'sale', 'sales_return', 'purchase_return', 'return_reversal')),
  reference TEXT NOT NULL DEFAULT '',
  authorized_user TEXT NOT NULL DEFAULT 'System'
);

INSERT INTO stock_movements_new
  (id, fabric_id, quantity_mm, reason, created_at, movement_type, reference, authorized_user)
SELECT id, fabric_id, quantity_mm, reason, created_at, movement_type, reference, authorized_user
FROM stock_movements;

DROP TABLE stock_movements;
ALTER TABLE stock_movements_new RENAME TO stock_movements;

CREATE INDEX stock_movements_fabric_idx ON stock_movements(fabric_id);
CREATE INDEX stock_movements_created_idx ON stock_movements(created_at);
CREATE INDEX stock_movements_type_idx ON stock_movements(movement_type);
