ALTER TABLE ledger_accounts ADD COLUMN is_payment_account INTEGER NOT NULL DEFAULT 0
  CHECK (is_payment_account IN (0, 1));
UPDATE ledger_accounts SET is_payment_account = 1 WHERE code IN ('1000', '1010');

ALTER TABLE customer_receipts ADD COLUMN receivable_minor INTEGER NOT NULL DEFAULT 0
  CHECK (receivable_minor >= 0);
ALTER TABLE customer_receipts ADD COLUMN advance_minor INTEGER NOT NULL DEFAULT 0
  CHECK (advance_minor >= 0);

UPDATE customer_receipts
SET receivable_minor = amount_minor
WHERE receivable_minor = 0 AND advance_minor = 0;
