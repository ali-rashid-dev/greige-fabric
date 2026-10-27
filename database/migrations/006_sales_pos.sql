ALTER TABLE invoices ADD COLUMN discount_minor INTEGER NOT NULL DEFAULT 0
  CHECK (discount_minor >= 0);
ALTER TABLE invoices ADD COLUMN amount_received_minor INTEGER NOT NULL DEFAULT 0
  CHECK (amount_received_minor >= 0 AND amount_received_minor <= total_minor);
ALTER TABLE invoices ADD COLUMN payment_account_code TEXT NOT NULL DEFAULT '1000'
  CHECK (payment_account_code IN ('1000', '1010'));
