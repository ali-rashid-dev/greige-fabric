CREATE TABLE business_partners (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  full_name TEXT NOT NULL,
  partner_type TEXT NOT NULL CHECK (partner_type IN ('PARTNER', 'INVESTOR')),
  investment_structure TEXT CHECK (investment_structure IN ('EQUITY', 'LOAN') OR investment_structure IS NULL),
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  joining_date TEXT NOT NULL,
  ownership_bps INTEGER NOT NULL DEFAULT 0 CHECK (ownership_bps BETWEEN 0 AND 10000),
  profit_sharing_bps INTEGER NOT NULL DEFAULT 0 CHECK (profit_sharing_bps BETWEEN 0 AND 10000),
  agreement_start_date TEXT NOT NULL,
  agreement_notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  internal_notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX business_partners_name_idx ON business_partners(full_name COLLATE NOCASE);
CREATE INDEX business_partners_status_type_idx ON business_partners(active, partner_type);

CREATE TABLE partner_agreements (
  id TEXT PRIMARY KEY NOT NULL,
  partner_id TEXT NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,
  effective_from TEXT NOT NULL,
  ownership_bps INTEGER NOT NULL CHECK (ownership_bps BETWEEN 0 AND 10000),
  profit_sharing_bps INTEGER NOT NULL CHECK (profit_sharing_bps BETWEEN 0 AND 10000),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (partner_id, effective_from)
);

CREATE INDEX partner_agreements_effective_idx ON partner_agreements(partner_id, effective_from DESC);

CREATE TABLE partner_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  partner_id TEXT NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN (
    'CAPITAL_CONTRIBUTION', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT',
    'PROFIT_ALLOCATION', 'PROFIT_DISTRIBUTION', 'PARTNER_WITHDRAWAL',
    'LOSS_ALLOCATION', 'CAPITAL_SETTLEMENT'
  )),
  transaction_date TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'BANK_TRANSFER', 'OTHER', 'JOURNAL')),
  payment_account_code TEXT REFERENCES ledger_accounts(code) ON DELETE RESTRICT,
  reference TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  supporting_notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
  journal_transaction_id TEXT NOT NULL UNIQUE REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
  reversal_of_transaction_id TEXT UNIQUE REFERENCES partner_transactions(id) ON DELETE RESTRICT,
  reversal_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK (
    (payment_method = 'JOURNAL' AND payment_account_code IS NULL)
    OR (payment_method != 'JOURNAL' AND payment_account_code IS NOT NULL)
  )
);

CREATE INDEX partner_transactions_partner_date_idx ON partner_transactions(partner_id, transaction_date, created_at);
CREATE INDEX partner_transactions_type_date_idx ON partner_transactions(transaction_type, transaction_date);

CREATE TABLE partner_profit_allocations (
  id TEXT PRIMARY KEY NOT NULL,
  partner_id TEXT NOT NULL REFERENCES business_partners(id) ON DELETE RESTRICT,
  period_id TEXT NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
  allocation_date TEXT NOT NULL,
  sharing_bps INTEGER NOT NULL CHECK (sharing_bps BETWEEN 0 AND 10000),
  amount_minor INTEGER NOT NULL CHECK (amount_minor != 0),
  transaction_id TEXT NOT NULL UNIQUE REFERENCES partner_transactions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (partner_id, period_id)
);

CREATE INDEX partner_profit_allocations_period_idx ON partner_profit_allocations(period_id);

INSERT INTO ledger_accounts (code, name, account_type, normal_balance)
SELECT '2210', 'Partner Loans Payable', 'liability', 'credit'
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE code = '2210');
INSERT INTO ledger_accounts (code, name, account_type, normal_balance)
SELECT '2220', 'Partner Profit Distributions Payable', 'liability', 'credit'
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE code = '2220');
INSERT INTO ledger_accounts (code, name, account_type, normal_balance)
SELECT '3100', 'Partner Profit & Loss Allocations', 'equity', 'credit'
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE code = '3100');
INSERT INTO ledger_accounts (code, name, account_type, normal_balance)
SELECT '3200', 'Partner Capital', 'equity', 'credit'
WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts WHERE code = '3200');

ALTER TABLE ledger_postings ADD COLUMN partner_id TEXT
  REFERENCES business_partners(id) ON DELETE RESTRICT;
CREATE INDEX ledger_postings_partner_account_idx ON ledger_postings(partner_id, account_code);

CREATE TRIGGER partner_transactions_immutable_update
BEFORE UPDATE ON partner_transactions
BEGIN
  SELECT RAISE(ABORT, 'Posted partner transactions are immutable.');
END;

CREATE TRIGGER partner_transactions_immutable_delete
BEFORE DELETE ON partner_transactions
BEGIN
  SELECT RAISE(ABORT, 'Posted partner transactions are immutable.');
END;

CREATE TRIGGER partner_agreements_immutable_update
BEFORE UPDATE ON partner_agreements
BEGIN
  SELECT RAISE(ABORT, 'Partner agreements are immutable.');
END;

CREATE TRIGGER partner_agreements_immutable_delete
BEFORE DELETE ON partner_agreements
BEGIN
  SELECT RAISE(ABORT, 'Partner agreements are immutable.');
END;

CREATE TRIGGER partner_profit_allocations_immutable_update
BEFORE UPDATE ON partner_profit_allocations
BEGIN
  SELECT RAISE(ABORT, 'Posted partner profit allocations are immutable.');
END;

CREATE TRIGGER partner_profit_allocations_immutable_delete
BEFORE DELETE ON partner_profit_allocations
BEGIN
  SELECT RAISE(ABORT, 'Posted partner profit allocations are immutable.');
END;
