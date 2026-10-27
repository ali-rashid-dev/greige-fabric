INSERT INTO ledger_accounts (code, name, account_type, normal_balance)
VALUES
  ('5200', 'Rent Expense', 'expense', 'debit'),
  ('5300', 'Salaries and Wages', 'expense', 'debit'),
  ('5400', 'Transport and Loading', 'expense', 'debit'),
  ('5500', 'Utilities Expense', 'expense', 'debit'),
  ('5600', 'Packaging and Miscellaneous', 'expense', 'debit'),
  ('5700', 'Other Expenses', 'expense', 'debit');

CREATE TABLE expense_categories (
  code TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  account_code TEXT NOT NULL UNIQUE REFERENCES ledger_accounts(code) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

INSERT INTO expense_categories (code, name, account_code)
VALUES
  ('rent', 'Rent', '5200'),
  ('salaries', 'Salaries and wages', '5300'),
  ('transport', 'Transport and loading', '5400'),
  ('utilities', 'Electricity and utilities', '5500'),
  ('packaging', 'Packaging and miscellaneous', '5600'),
  ('other', 'Other expenses', '5700');

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
