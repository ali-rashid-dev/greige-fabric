CREATE TABLE customer_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  receipt_number TEXT NOT NULL UNIQUE,
  account_code TEXT NOT NULL CHECK (account_code IN ('1000', '1010')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX customer_receipts_customer_idx
  ON customer_receipts(customer_id, created_at);
