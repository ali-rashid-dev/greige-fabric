ALTER TABLE ledger_accounts ADD COLUMN normal_balance TEXT NOT NULL DEFAULT 'debit'
  CHECK (normal_balance IN ('debit', 'credit'));

UPDATE ledger_accounts
SET normal_balance = CASE
  WHEN account_type IN ('liability', 'equity', 'income') THEN 'credit'
  ELSE 'debit'
END;

CREATE TRIGGER ledger_accounts_normal_balance_insert
BEFORE INSERT ON ledger_accounts
WHEN NEW.normal_balance != CASE
  WHEN NEW.account_type IN ('liability', 'equity', 'income') THEN 'credit'
  ELSE 'debit'
END
BEGIN
  SELECT RAISE(ABORT, 'Account normal balance does not match its type.');
END;

CREATE TRIGGER ledger_accounts_normal_balance_update
BEFORE UPDATE OF account_type, normal_balance ON ledger_accounts
WHEN NEW.normal_balance != CASE
  WHEN NEW.account_type IN ('liability', 'equity', 'income') THEN 'credit'
  ELSE 'debit'
END
BEGIN
  SELECT RAISE(ABORT, 'Account normal balance does not match its type.');
END;

CREATE TABLE accounting_periods (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  CHECK (starts_on <= ends_on)
);

CREATE TRIGGER accounting_periods_no_overlap_insert
BEFORE INSERT ON accounting_periods
WHEN EXISTS (
  SELECT 1 FROM accounting_periods
  WHERE NEW.starts_on <= ends_on AND NEW.ends_on >= starts_on
)
BEGIN
  SELECT RAISE(ABORT, 'Accounting periods cannot overlap.');
END;

CREATE TRIGGER accounting_periods_no_overlap_update
BEFORE UPDATE OF starts_on, ends_on ON accounting_periods
WHEN EXISTS (
  SELECT 1 FROM accounting_periods
  WHERE id != NEW.id AND NEW.starts_on <= ends_on AND NEW.ends_on >= starts_on
)
BEGIN
  SELECT RAISE(ABORT, 'Accounting periods cannot overlap.');
END;

WITH RECURSIVE months(month) AS (
  SELECT substr(created_at, 1, 7) FROM ledger_transactions
  WHERE length(created_at) >= 7
  UNION
  SELECT strftime('%Y-%m', month || '-01', '+1 month')
  FROM months
  WHERE month < strftime('%Y-%m', 'now')
)
INSERT INTO accounting_periods (id, name, starts_on, ends_on, status, created_at)
SELECT month, month, month || '-01',
       date(month || '-01', '+1 month', '-1 day'), 'open',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM months
WHERE month IS NOT NULL;

INSERT INTO accounting_periods (id, name, starts_on, ends_on, status, created_at)
SELECT strftime('%Y-%m', 'now'), strftime('%Y-%m', 'now'),
       date('now', 'start of month'),
       date('now', 'start of month', '+1 month', '-1 day'),
       'open', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM accounting_periods
  WHERE starts_on <= date('now') AND ends_on >= date('now')
);

ALTER TABLE ledger_transactions ADD COLUMN source_key TEXT;
ALTER TABLE ledger_transactions ADD COLUMN reversal_of_transaction_id TEXT
  REFERENCES ledger_transactions(id) ON DELETE RESTRICT;
ALTER TABLE ledger_transactions ADD COLUMN reversal_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE ledger_transactions ADD COLUMN period_id TEXT
  REFERENCES accounting_periods(id) ON DELETE RESTRICT;

UPDATE ledger_transactions
SET source_key = 'legacy:' || id,
    period_id = substr(created_at, 1, 7)
WHERE length(created_at) >= 7;

CREATE UNIQUE INDEX ledger_transactions_source_key_idx
  ON ledger_transactions(source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX ledger_transactions_reversal_idx
  ON ledger_transactions(reversal_of_transaction_id)
  WHERE reversal_of_transaction_id IS NOT NULL;
CREATE INDEX ledger_transactions_period_idx ON ledger_transactions(period_id);

CREATE TRIGGER ledger_transactions_immutable_update
BEFORE UPDATE ON ledger_transactions
BEGIN
  SELECT RAISE(ABORT, 'Posted journal entries are immutable.');
END;

CREATE TRIGGER ledger_transactions_immutable_delete
BEFORE DELETE ON ledger_transactions
BEGIN
  SELECT RAISE(ABORT, 'Posted journal entries are immutable.');
END;

CREATE TRIGGER ledger_postings_immutable_update
BEFORE UPDATE ON ledger_postings
BEGIN
  SELECT RAISE(ABORT, 'Posted journal lines are immutable.');
END;

CREATE TRIGGER ledger_postings_immutable_delete
BEFORE DELETE ON ledger_postings
BEGIN
  SELECT RAISE(ABORT, 'Posted journal lines are immutable.');
END;
