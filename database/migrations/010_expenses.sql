CREATE TEMP TABLE expense_account_seed (
  category_code TEXT PRIMARY KEY,
  category_name TEXT NOT NULL,
  preferred_code TEXT NOT NULL,
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL
);

INSERT INTO expense_account_seed (category_code, category_name, preferred_code, account_code, account_name)
VALUES
  ('rent', 'Rent', '5200', '5200', 'Rent Expense'),
  ('salaries', 'Salaries and wages', '5300', '5300', 'Salaries and Wages'),
  ('transport', 'Transport and loading', '5400', '5400', 'Transport and Loading'),
  ('utilities', 'Electricity and utilities', '5500', '5500', 'Utilities Expense'),
  ('packaging', 'Packaging and miscellaneous', '5600', '5600', 'Packaging and Miscellaneous'),
  ('other', 'Other expenses', '5700', '5700', 'Other Expenses');

UPDATE expense_account_seed
SET account_code = (
  SELECT CAST(
    COALESCE((SELECT MAX(CAST(code AS INTEGER)) FROM ledger_accounts WHERE code GLOB '[0-9]*'), 5700)
    + 10 * (
      SELECT COUNT(*)
      FROM expense_account_seed AS candidate
      WHERE candidate.preferred_code <= expense_account_seed.preferred_code
        AND EXISTS (SELECT 1 FROM ledger_accounts WHERE code = candidate.preferred_code)
    )
    AS TEXT
  )
)
WHERE EXISTS (SELECT 1 FROM ledger_accounts WHERE code = expense_account_seed.preferred_code);

INSERT INTO ledger_accounts (code, name, account_type, normal_balance)
SELECT account_code, account_name, 'expense', 'debit'
FROM expense_account_seed;

CREATE TABLE expense_categories (
  code TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  account_code TEXT NOT NULL UNIQUE REFERENCES ledger_accounts(code) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

INSERT INTO expense_categories (code, name, account_code)
SELECT category_code, category_name, account_code
FROM expense_account_seed;

DROP TABLE expense_account_seed;

CREATE TABLE expenses (
  id TEXT PRIMARY KEY NOT NULL,
  expense_number TEXT NOT NULL UNIQUE,
  category_code TEXT NOT NULL REFERENCES expense_categories(code) ON DELETE RESTRICT,
  payment_account_code TEXT NOT NULL REFERENCES ledger_accounts(code) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  expense_date TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX expenses_date_idx ON expenses(expense_date, created_at);
CREATE INDEX expenses_category_idx ON expenses(category_code, expense_date);
