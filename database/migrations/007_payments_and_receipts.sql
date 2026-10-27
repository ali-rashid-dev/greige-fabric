INSERT OR IGNORE INTO ledger_accounts (code, name, account_type)
VALUES ('2200', 'Customer Advances', 'liability');

ALTER TABLE supplier_payments ADD COLUMN reversed_at TEXT;
ALTER TABLE supplier_payments ADD COLUMN reversal_reason TEXT NOT NULL DEFAULT '';

CREATE TABLE customer_receipts_new (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  receipt_number TEXT NOT NULL UNIQUE,
  account_code TEXT NOT NULL REFERENCES ledger_accounts(code) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  reversed_at TEXT,
  reversal_reason TEXT NOT NULL DEFAULT ''
);

INSERT INTO customer_receipts_new (
  id, customer_id, receipt_number, account_code, amount_minor, reference, note, created_at
)
SELECT id, customer_id, receipt_number, account_code, amount_minor, reference, note, created_at
FROM customer_receipts;

DROP TABLE customer_receipts;
ALTER TABLE customer_receipts_new RENAME TO customer_receipts;

CREATE INDEX customer_receipts_customer_idx
  ON customer_receipts(customer_id, created_at);
CREATE INDEX customer_receipts_invoice_idx
  ON customer_receipts(invoice_id);
