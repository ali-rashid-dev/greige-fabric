CREATE TABLE customers (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  credit_limit_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit_minor >= 0),
  payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX customers_name_idx ON customers(name);

ALTER TABLE invoices ADD COLUMN customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT;
CREATE INDEX invoices_customer_idx ON invoices(customer_id, created_at);

ALTER TABLE ledger_postings ADD COLUMN customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT;
CREATE INDEX ledger_postings_customer_idx ON ledger_postings(customer_id);
