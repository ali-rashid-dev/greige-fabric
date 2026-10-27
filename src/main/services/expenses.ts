import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Expense, ExpenseCategory, ExpenseReport } from "../../shared/types";
import type { ExpenseInput } from "../../shared/contracts";
import { postJournal } from "./accounting";
import { FabricServiceError } from "./errors";
import { writeAuditLog } from "./audit";

interface ExpenseRow {
  id: string;
  expense_number: string;
  category_code: string;
  category_name: string;
  expense_account_code: string;
  payment_account_code: string;
  payment_account_name: string;
  amount_minor: number;
  expense_date: string;
  description: string;
  created_at: string;
  is_reversed: number;
}

export class ExpenseService {
  constructor(private readonly database: Database.Database) {}

  categories(): ExpenseCategory[] {
    return (this.database.prepare(`
      SELECT c.code, c.name, c.account_code, a.name AS account_name
      FROM expense_categories c
      JOIN ledger_accounts a ON a.code = c.account_code
      WHERE c.active = 1 ORDER BY c.name COLLATE NOCASE
    `).all() as Array<{
      code: string;
      name: string;
      account_code: string;
      account_name: string;
    }>).map((row) => ({
      code: row.code,
      name: row.name,
      accountCode: row.account_code,
      accountName: row.account_name,
    }));
  }

  addCategory(input: { code: string; name: string }): ExpenseCategory {
    const code = input.code.trim().toLowerCase();
    const name = input.name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(code) || !name || name.length > 120) {
      throw new FabricServiceError("VALIDATION", "Enter a valid expense category name and code.");
    }
    const accountCode = this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT c.account_code, a.account_type FROM expense_categories c
        JOIN ledger_accounts a ON a.code = c.account_code WHERE c.code = ?
      `).get(code) as { account_code: string; account_type: string } | undefined;
      if (existing) {
        if (existing.account_type !== "expense") {
          throw new FabricServiceError("CONFLICT", "The category code is already assigned to a non-expense account.");
        }
        this.database.prepare(
          "UPDATE expense_categories SET name = ?, active = 1 WHERE code = ?",
        ).run(name, code);
        this.database.prepare("UPDATE ledger_accounts SET name = ? WHERE code = ?")
          .run(`${name} Expense`, existing.account_code);
        return existing.account_code;
      }

      const { next_code: codeNumber } = this.database.prepare(`
        SELECT COALESCE(MAX(CAST(code AS INTEGER)), 5700) + 10 AS next_code
        FROM ledger_accounts WHERE code GLOB '[0-9]*'
      `).get() as { next_code: number };
      if (!Number.isSafeInteger(codeNumber) || codeNumber > 999_999) {
        throw new FabricServiceError("CONFLICT", "No more expense account codes are available.");
      }
      const nextAccountCode = String(codeNumber);
      this.database.prepare(`
        INSERT INTO ledger_accounts (code, name, account_type, normal_balance)
        VALUES (?, ?, 'expense', 'debit')
      `).run(nextAccountCode, `${name} Expense`);
      this.database.prepare(`
        INSERT INTO expense_categories (code, name, account_code) VALUES (?, ?, ?)
      `).run(code, name, nextAccountCode);
      return nextAccountCode;
    }).immediate();

    return {
      code,
      name,
      accountCode,
      accountName: `${name} Expense`,
    };
  }

  record(input: ExpenseInput): Expense {
    const id = randomUUID();
    const expenseNumber = `EXP-${input.expenseDate.replaceAll("-", "")}-${id.slice(0, 6).toUpperCase()}`;
    const createdAt = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const category = this.database.prepare(`
        SELECT c.account_code, a.account_type FROM expense_categories c
        JOIN ledger_accounts a ON a.code = c.account_code
        WHERE c.code = ? AND c.active = 1
      `).get(input.categoryCode) as { account_code: string; account_type: string } | undefined;
      if (!category) throw new FabricServiceError("NOT_FOUND", "Expense category not found.");
      if (category.account_type !== "expense") {
        throw new FabricServiceError("VALIDATION", "Expenses must post to an expense account.");
      }
      const paymentAccount = this.database.prepare(`
        SELECT name FROM ledger_accounts
        WHERE code = ? AND account_type = 'asset' AND is_payment_account = 1
      `).get(input.paymentAccountCode) as { name: string } | undefined;
      if (!paymentAccount) {
        throw new FabricServiceError("VALIDATION", "Choose a configured cash or payment account.");
      }
      this.database.prepare(`
        INSERT INTO expenses (
          id, expense_number, category_code, payment_account_code,
          amount_minor, expense_date, description, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, expenseNumber, input.categoryCode, input.paymentAccountCode,
        Math.round(input.amount * 100), input.expenseDate, input.description, createdAt,
      );
      postJournal(this.database, "expense", expenseNumber, `${input.expenseDate}T12:00:00.000Z`, [
        { accountCode: category.account_code, debitMinor: Math.round(input.amount * 100) },
        { accountCode: input.paymentAccountCode, creditMinor: Math.round(input.amount * 100) },
      ], "Expense entry", id);
      writeAuditLog(
        this.database, "Operator", "expense", "expense", id, input.description,
        createdAt,
      );
    });
    transaction.immediate();
    return this.get(id);
  }

  list(input: { from: string; to: string }): Expense[] {
    return this.rows(input.from, input.to).map((row) => this.mapExpense(row));
  }

  report(input: { from: string; to: string }): ExpenseReport {
    const rows = this.database.prepare(`
      SELECT c.code AS category_code, c.name AS category_name,
        a.code AS expense_account_code, COALESCE(SUM(p.debit_minor - p.credit_minor), 0) AS amount_minor,
        COUNT(DISTINCT CASE WHEN t.id IS NOT NULL THEN e.id END) AS expense_count
      FROM expense_categories c
      JOIN ledger_accounts a ON a.code = c.account_code
      LEFT JOIN expenses e ON e.category_code = c.code
        AND e.expense_date >= ? AND e.expense_date <= ?
      LEFT JOIN ledger_transactions t
        ON t.source_key = 'expense:' || e.id AND t.transaction_type = 'expense'
      LEFT JOIN ledger_transactions reversal
        ON reversal.reversal_of_transaction_id = t.id
        AND substr(reversal.created_at, 1, 10) >= ?
        AND substr(reversal.created_at, 1, 10) <= ?
      LEFT JOIN ledger_postings p
        ON p.transaction_id IN (t.id, reversal.id) AND p.account_code = a.code
      WHERE c.active = 1
      GROUP BY c.code ORDER BY c.name COLLATE NOCASE
    `).all(input.from, input.to, input.from, input.to) as Array<{
      category_code: string;
      category_name: string;
      expense_account_code: string;
      amount_minor: number;
      expense_count: number;
    }>;
    const categories = rows.map((row) => ({
      categoryCode: row.category_code,
      categoryName: row.category_name,
      accountCode: row.expense_account_code,
      amountMinor: row.amount_minor,
      expenseCount: row.expense_count,
    }));
    return {
      from: input.from,
      to: input.to,
      categories,
      totalMinor: categories.reduce((sum, item) => sum + item.amountMinor, 0),
    };
  }

  private get(id: string): Expense {
    const row = this.database.prepare(`
      SELECT e.id, e.expense_number, e.category_code, c.name AS category_name,
        c.account_code AS expense_account_code, e.payment_account_code,
        p.name AS payment_account_name, e.amount_minor, e.expense_date,
        e.description, e.created_at,
        EXISTS (
          SELECT 1 FROM ledger_transactions t
          JOIN ledger_transactions reversal ON reversal.reversal_of_transaction_id = t.id
          WHERE t.source_key = 'expense:' || e.id AND t.transaction_type = 'expense'
        ) AS is_reversed
      FROM expenses e
      JOIN expense_categories c ON c.code = e.category_code
      JOIN ledger_accounts p ON p.code = e.payment_account_code
      WHERE e.id = ?
    `).get(id) as ExpenseRow | undefined;
    if (!row) throw new FabricServiceError("NOT_FOUND", "Expense not found.");
    return this.mapExpense(row);
  }

  private rows(from: string, to: string): ExpenseRow[] {
    return this.database.prepare(`
      SELECT e.id, e.expense_number, e.category_code, c.name AS category_name,
        c.account_code AS expense_account_code, e.payment_account_code,
        p.name AS payment_account_name, e.amount_minor, e.expense_date,
        e.description, e.created_at,
        EXISTS (
          SELECT 1 FROM ledger_transactions t
          JOIN ledger_transactions reversal ON reversal.reversal_of_transaction_id = t.id
          WHERE t.source_key = 'expense:' || e.id AND t.transaction_type = 'expense'
        ) AS is_reversed
      FROM expenses e
      JOIN expense_categories c ON c.code = e.category_code
      JOIN ledger_accounts p ON p.code = e.payment_account_code
      WHERE e.expense_date >= ? AND e.expense_date <= ?
      ORDER BY e.expense_date DESC, e.created_at DESC
    `).all(from, to) as ExpenseRow[];
  }

  private mapExpense(row: ExpenseRow): Expense {
    return {
      id: row.id,
      expenseNumber: row.expense_number,
      categoryCode: row.category_code,
      categoryName: row.category_name,
      expenseAccountCode: row.expense_account_code,
      paymentAccountCode: row.payment_account_code,
      paymentAccountName: row.payment_account_name,
      amountMinor: row.amount_minor,
      expenseDate: row.expense_date,
      description: row.description,
      createdAt: row.created_at,
      isReversed: row.is_reversed === 1,
    };
  }
}
