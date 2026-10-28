import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AccountingPeriod,
  AccountingReconciliation,
  AccountType,
  ChartOfAccount,
  GeneralLedger,
  JournalEntry,
  JournalLineInput,
  NormalBalance,
  ReconciliationCheck,
  TrialBalance,
} from "../../shared/types";
import { FabricServiceError } from "./errors";
import { writeAuditLog } from "./audit";

interface JournalTransactionRow {
  id: string;
  transaction_type: string;
  reference: string;
  authorized_user: string;
  created_at: string;
  period_id: string | null;
  reversal_of_transaction_id: string | null;
  reversal_reason?: string;
}

interface JournalPostingRow {
  account_code: string;
  account_name: string;
  debit_minor: number;
  credit_minor: number;
  supplier_id: string | null;
  customer_id: string | null;
}

interface ChartOfAccountRow {
  code: string;
  name: string;
  account_type: AccountType;
  normal_balance: NormalBalance;
  is_payment_account: number;
}

const normalBalanceByType: Record<AccountType, NormalBalance> = {
  asset: "debit",
  liability: "credit",
  equity: "credit",
  income: "credit",
  expense: "debit",
};

function toChartOfAccount(row: ChartOfAccountRow): ChartOfAccount {
  return {
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    normalBalance: row.normal_balance,
    isPaymentAccount: row.is_payment_account === 1,
  };
}

function roundedDivision(numerator: bigint, denominator: bigint): number {
  const result = (numerator + denominator / 2n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FabricServiceError("VALIDATION", "The amount exceeds the supported accounting precision.");
  }
  return Number(result);
}

export function calculateMinorValue(quantityMm: number, unitCostMinor: number): number {
  return roundedDivision(BigInt(quantityMm) * BigInt(unitCostMinor), 1000n);
}

export function calculateProportionalValue(totalMinor: number, part: number, whole: number): number {
  if (whole <= 0) return 0;
  return roundedDivision(BigInt(totalMinor) * BigInt(part), BigInt(whole));
}

export function allocateMinorValue(totalMinor: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || weights.length === 0) {
    throw new FabricServiceError("VALIDATION", "Acquisition costs cannot be allocated to the supplied purchase lines.");
  }
  const totalWeight = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (totalWeight <= 0n || weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)) {
    throw new FabricServiceError("VALIDATION", "Purchase lines must have valid quantities and costs.");
  }
  const total = BigInt(totalMinor);
  const allocations = weights.map((weight) => {
    const numerator = total * BigInt(weight);
    return {
      amount: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });
  let remainder = total - allocations.reduce((sum, item) => sum + item.amount, 0n);
  const order = allocations.map((item, index) => ({ index, remainder: item.remainder }))
    .sort((left, right) => left.remainder > right.remainder ? -1 : left.remainder < right.remainder ? 1 : left.index - right.index);
  for (let index = 0; remainder > 0n; index += 1, remainder -= 1n) {
    allocations[order[index].index].amount += 1n;
  }
  return allocations.map((item) => {
    if (item.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new FabricServiceError("VALIDATION", "Allocated acquisition costs exceed supported accounting precision.");
    }
    return Number(item.amount);
  });
}

export function postJournal(
  database: Database.Database,
  transactionType: string,
  reference: string,
  createdAt: string,
  lines: JournalLineInput[],
  authorizedUser = "System",
  sourceId?: string,
  reversalOfTransactionId?: string,
  reversalReason = "",
): void {
  if (!sourceId?.trim()) {
    throw new FabricServiceError("VALIDATION", "A source transaction ID is required for journal posting.");
  }
  const parsedDate = createdAt.slice(0, 10);
  const dateValue = new Date(`${parsedDate}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parsedDate)
    || Number.isNaN(dateValue.getTime())
    || dateValue.toISOString().slice(0, 10) !== parsedDate
  ) {
    throw new FabricServiceError("VALIDATION", "The journal date is invalid.");
  }
  for (const line of lines) {
    const debit = line.debitMinor ?? 0;
    const credit = line.creditMinor ?? 0;
    if (
      !Number.isSafeInteger(debit) || debit < 0
      || !Number.isSafeInteger(credit) || credit < 0
      || (debit > 0 && credit > 0)
    ) {
      throw new FabricServiceError("VALIDATION", "Each journal line must have one positive debit or credit.");
    }
  }
  const debitMinor = lines.reduce((total, line) => total + BigInt(line.debitMinor ?? 0), 0n);
  const creditMinor = lines.reduce((total, line) => total + BigInt(line.creditMinor ?? 0), 0n);
  if (
    debitMinor > BigInt(Number.MAX_SAFE_INTEGER)
    || creditMinor > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new FabricServiceError("VALIDATION", "The journal entry exceeds the supported accounting precision.");
  }
  if (debitMinor !== creditMinor) {
    throw new FabricServiceError(
      "VALIDATION",
      `The journal entry is not balanced (${debitMinor} != ${creditMinor}).`,
    );
  }
  if (debitMinor === 0n) return;
  if (lines.length < 2) {
    throw new FabricServiceError("VALIDATION", "A journal entry must contain at least two journal lines.");
  }

  const sourceKey = `${transactionType}:${sourceId}`;
  const effectiveLines = lines.filter((line) => (line.debitMinor ?? 0) > 0 || (line.creditMinor ?? 0) > 0);
  if (effectiveLines.length < 2) {
    throw new FabricServiceError("VALIDATION", "A journal entry must contain at least two journal lines.");
  }
  const transaction = database.transaction(() => {
    const periodId = requireOpenPeriod(database, parsedDate);
    for (const line of effectiveLines) {
      if ([line.customerId, line.supplierId, line.partnerId].filter(Boolean).length > 1) {
        throw new FabricServiceError("VALIDATION", "A journal line cannot reference more than one subledger party.");
      }
      const account = database.prepare(
        "SELECT code FROM ledger_accounts WHERE code = ?",
      ).get(line.accountCode) as { code: string } | undefined;
      if (!account) throw new FabricServiceError("NOT_FOUND", `Ledger account ${line.accountCode} was not found.`);
      if (line.customerId && line.accountCode !== "1300" && line.accountCode !== "2200") {
        throw new FabricServiceError("VALIDATION", "Customer subledger references require a receivable or advance account.");
      }
      if (line.supplierId && line.accountCode !== "2100") {
        throw new FabricServiceError("VALIDATION", "Supplier subledger references require the payable account.");
      }
      if (line.partnerId) {
        const partner = database.prepare(
          "SELECT id FROM business_partners WHERE id = ?",
        ).get(line.partnerId);
        if (!partner) throw new FabricServiceError("NOT_FOUND", "The partner subledger record was not found.");
        if (!["2210", "2220", "3200"].includes(line.accountCode)) {
          throw new FabricServiceError("VALIDATION", "Partner subledger references require a partner account.");
        }
      }
      if (transactionType === "manual_journal" || transactionType === "opening_balance") {
        if ((line.accountCode === "1300" || line.accountCode === "2200") && !line.customerId) {
          throw new FabricServiceError("VALIDATION", "Receivable and customer-advance lines require a customer.");
        }
        if (line.accountCode === "2100" && !line.supplierId) {
          throw new FabricServiceError("VALIDATION", "Payable lines require a supplier.");
        }
      }
    }

    const transactionId = randomUUID();
    database.prepare(`
      INSERT INTO ledger_transactions (
        id, transaction_type, reference, authorized_user, created_at,
        source_key, reversal_of_transaction_id, reversal_reason, period_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transactionId, transactionType, reference, authorizedUser, createdAt,
      sourceKey, reversalOfTransactionId ?? null, reversalReason, periodId,
    );
    const insertPosting = database.prepare(`
      INSERT INTO ledger_postings (
        id, transaction_id, account_code, supplier_id, customer_id, partner_id, debit_minor, credit_minor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const line of effectiveLines) {
      insertPosting.run(
        randomUUID(),
        transactionId,
        line.accountCode,
        line.supplierId ?? null,
        line.customerId ?? null,
        line.partnerId ?? null,
        line.debitMinor ?? 0,
        line.creditMinor ?? 0,
      );
    }
  });
  transaction.immediate();
}

function requireOpenPeriod(database: Database.Database, date: string): string {
  const latestClosed = database.prepare(`
    SELECT ends_on FROM accounting_periods
    WHERE status = 'closed' ORDER BY ends_on DESC LIMIT 1
  `).get() as { ends_on: string } | undefined;
  if (latestClosed && date <= latestClosed.ends_on) {
    throw new FabricServiceError("CONFLICT", "The journal date is on or before the latest closed accounting period.");
  }
  const existing = database.prepare(`
    SELECT id, status FROM accounting_periods WHERE starts_on <= ? AND ends_on >= ?
  `).get(date, date) as { id: string; status: "open" | "closed" } | undefined;
  if (existing) {
    if (existing.status !== "open") {
      throw new FabricServiceError("CONFLICT", "The accounting period for this journal date is closed.");
    }
    return existing.id;
  }

  const month = date.slice(0, 7);
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  if (monthNumber < 1 || monthNumber > 12) {
    throw new FabricServiceError("VALIDATION", "The journal date is invalid.");
  }
  const startsOn = `${month}-01`;
  const endsOn = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  database.prepare(`
    INSERT INTO accounting_periods (id, name, starts_on, ends_on, status, created_at)
    VALUES (?, ?, ?, ?, 'open', ?)
  `).run(month, month, startsOn, endsOn, new Date().toISOString());
  return month;
}

export class AccountingService {
  constructor(private readonly database: Database.Database) {}

  listAccounts(): ChartOfAccount[] {
    const rows = this.database.prepare(`
      SELECT code, name, account_type, normal_balance, is_payment_account
      FROM ledger_accounts ORDER BY code
    `).all() as ChartOfAccountRow[];
    return rows.map(toChartOfAccount);
  }

  createAccount(input: {
    code: string;
    name: string;
    accountType: AccountType;
    isPaymentAccount: boolean;
  }): ChartOfAccount {
    if (input.isPaymentAccount && input.accountType !== "asset") {
      throw new FabricServiceError("VALIDATION", "Only asset accounts can be configured as payment accounts.");
    }
    try {
      this.database.prepare(`
        INSERT INTO ledger_accounts (code, name, account_type, is_payment_account, normal_balance)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        input.code, input.name, input.accountType, input.isPaymentAccount ? 1 : 0,
        normalBalanceByType[input.accountType],
      );
    } catch (error) {
      if (
        error instanceof Error && "code" in error
        && (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
      ) {
        throw new FabricServiceError("CONFLICT", "A ledger account with this code already exists.");
      }
      throw error;
    }
    const account = this.database.prepare(`
      SELECT code, name, account_type, normal_balance, is_payment_account
      FROM ledger_accounts WHERE code = ?
    `).get(input.code) as ChartOfAccountRow;
    return toChartOfAccount(account);
  }

  updateAccount(input: {
    code: string;
    name: string;
    isPaymentAccount: boolean;
  }): ChartOfAccount {
    const account = this.database.prepare(`
      SELECT code, account_type FROM ledger_accounts WHERE code = ?
    `).get(input.code) as { code: string; account_type: AccountType } | undefined;
    if (!account) throw new FabricServiceError("NOT_FOUND", "Ledger account not found.");
    if (input.isPaymentAccount && account.account_type !== "asset") {
      throw new FabricServiceError("VALIDATION", "Only asset accounts can be configured as payment accounts.");
    }
    this.database.prepare(`
      UPDATE ledger_accounts SET name = ?, is_payment_account = ? WHERE code = ?
    `).run(input.name, input.isPaymentAccount ? 1 : 0, input.code);
    return this.listAccounts().find((item) => item.code === input.code)!;
  }

  listPeriods(): AccountingPeriod[] {
    return (this.database.prepare(`
      SELECT id, name, starts_on, ends_on, status
      FROM accounting_periods ORDER BY starts_on DESC
    `).all() as Array<{
      id: string;
      name: string;
      starts_on: string;
      ends_on: string;
      status: "open" | "closed";
    }>).map((row) => ({
      id: row.id,
      name: row.name,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      status: row.status,
    }));
  }

  closePeriod(id: string): AccountingPeriod {
    const period = this.database.prepare(`
      SELECT id, starts_on FROM accounting_periods WHERE id = ?
    `).get(id) as { id: string; starts_on: string } | undefined;
    if (!period) throw new FabricServiceError("NOT_FOUND", "Accounting period not found.");
    const earlierOpenPeriod = this.database.prepare(`
      SELECT id FROM accounting_periods
      WHERE starts_on < ? AND status = 'open' LIMIT 1
    `).get(period.starts_on);
    if (earlierOpenPeriod) {
      throw new FabricServiceError("CONFLICT", "Close earlier open accounting periods first.");
    }
    const now = new Date().toISOString();
    const close = this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE accounting_periods SET status = 'closed'
        WHERE id = ? AND status = 'open'
      `).run(id);
      if (result.changes === 0) {
        throw new FabricServiceError("CONFLICT", "This accounting period is already closed.");
      }
      writeAuditLog(this.database, "Owner", "accounting_period_closed", "accounting_period", id, `Closed period ${id}`, now);
    });
    close.immediate();
    return this.listPeriods().find((period) => period.id === id)!;
  }

  trialBalance(asOf: string): TrialBalance {
    const rows = this.database.prepare(`
      SELECT a.code, a.name, a.account_type, a.normal_balance,
        COALESCE(b.balance_minor, 0) AS balance_minor
      FROM ledger_accounts a
      LEFT JOIN (
        SELECT p.account_code, SUM(p.debit_minor - p.credit_minor) AS balance_minor
        FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
        WHERE substr(t.created_at, 1, 10) <= ?
        GROUP BY p.account_code
      ) b ON b.account_code = a.code
      ORDER BY a.code
    `).all(asOf) as Array<{
      code: string;
      name: string;
      account_type: AccountType;
      normal_balance: NormalBalance;
      balance_minor: number;
    }>;
    if (rows.some((row) => !Number.isSafeInteger(row.balance_minor))) {
      throw new FabricServiceError("VALIDATION", "The trial balance exceeds the supported accounting precision.");
    }
    const lines = rows.map((row) => ({
      accountCode: row.code,
      accountName: row.name,
      accountType: row.account_type,
      normalBalance: row.normal_balance,
      debitMinor: Math.max(row.balance_minor, 0),
      creditMinor: Math.max(-row.balance_minor, 0),
    }));
    const totalDebitsMinor = lines.reduce((sum, line) => sum + line.debitMinor, 0);
    const totalCreditsMinor = lines.reduce((sum, line) => sum + line.creditMinor, 0);
    if (!Number.isSafeInteger(totalDebitsMinor) || !Number.isSafeInteger(totalCreditsMinor)) {
      throw new FabricServiceError("VALIDATION", "The trial balance exceeds the supported accounting precision.");
    }
    return {
      asOf,
      lines,
      totalDebitsMinor,
      totalCreditsMinor,
      isBalanced: totalDebitsMinor === totalCreditsMinor,
    };
  }

  generalLedger(input: { accountCode: string; from: string; to: string }): GeneralLedger {
    const accountRow = this.database.prepare(`
      SELECT code, name, account_type, normal_balance, is_payment_account
      FROM ledger_accounts WHERE code = ?
    `).get(input.accountCode) as ChartOfAccountRow | undefined;
    if (!accountRow) throw new FabricServiceError("NOT_FOUND", "Ledger account not found.");
    const opening = this.database.prepare(`
      SELECT COALESCE(SUM(p.debit_minor - p.credit_minor), 0) AS balance_minor
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = ? AND substr(t.created_at, 1, 10) < ?
    `).get(input.accountCode, input.from) as { balance_minor: number };
    if (!Number.isSafeInteger(opening.balance_minor)) {
      throw new FabricServiceError("VALIDATION", "The general ledger exceeds the supported accounting precision.");
    }
    const rows = this.database.prepare(`
      SELECT t.id, t.transaction_type, t.reference, t.created_at, p.debit_minor, p.credit_minor
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = ? AND substr(t.created_at, 1, 10) >= ?
        AND substr(t.created_at, 1, 10) <= ?
      ORDER BY t.created_at, t.rowid, p.rowid
    `).all(input.accountCode, input.from, input.to) as Array<{
      id: string;
      transaction_type: string;
      reference: string;
      created_at: string;
      debit_minor: number;
      credit_minor: number;
    }>;
    let balanceMinor = opening.balance_minor;
    const lines = rows.map((row) => {
      balanceMinor += row.debit_minor - row.credit_minor;
      if (!Number.isSafeInteger(balanceMinor)) {
        throw new FabricServiceError("VALIDATION", "The general ledger exceeds the supported accounting precision.");
      }
      return {
        transactionId: row.id,
        transactionType: row.transaction_type,
        reference: row.reference,
        createdAt: row.created_at,
        debitMinor: row.debit_minor,
        creditMinor: row.credit_minor,
        balanceMinor,
      };
    });
    return {
      account: toChartOfAccount(accountRow),
      from: input.from,
      to: input.to,
      openingBalanceMinor: opening.balance_minor,
      closingBalanceMinor: balanceMinor,
      lines,
    };
  }

  listEntries(limit = 100): JournalEntry[] {
    const rows = this.database.prepare(`
      SELECT t.id, t.transaction_type, t.reference, t.authorized_user, t.created_at,
        t.period_id, t.reversal_of_transaction_id, t.reversal_reason,
        (SELECT r.id FROM ledger_transactions r WHERE r.reversal_of_transaction_id = t.id) AS reversed_by
      FROM ledger_transactions t
      ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?
    `).all(limit) as Array<JournalTransactionRow & { reversed_by: string | null }>;
    return rows.map((row) => this.mapEntry(row));
  }

  getEntry(id: string): JournalEntry {
    const row = this.database.prepare(`
      SELECT t.id, t.transaction_type, t.reference, t.authorized_user, t.created_at,
        t.period_id, t.reversal_of_transaction_id, t.reversal_reason,
        (SELECT r.id FROM ledger_transactions r WHERE r.reversal_of_transaction_id = t.id) AS reversed_by
      FROM ledger_transactions t WHERE t.id = ?
    `).get(id) as (JournalTransactionRow & { reversed_by: string | null }) | undefined;
    if (!row) throw new FabricServiceError("NOT_FOUND", "Journal entry not found.");
    return this.mapEntry(row);
  }

  postEntry(input: {
    sourceId: string;
    reference: string;
    date: string;
    lines: JournalLineInput[];
  }): JournalEntry {
    const createdAt = `${input.date}T12:00:00.000Z`;
    const auditedAt = new Date().toISOString();
    const post = this.database.transaction(() => {
      postJournal(
        this.database,
        "manual_journal",
        input.reference,
        createdAt,
        input.lines,
        "Owner",
        input.sourceId,
      );
      if (!this.database.prepare(
        "SELECT id FROM ledger_transactions WHERE source_key = ?",
      ).get(`manual_journal:${input.sourceId}`)) {
        throw new FabricServiceError("VALIDATION", "A manual journal entry cannot have a zero amount.");
      }
      writeAuditLog(this.database, "Owner", "manual_journal", "journal", input.sourceId, input.reference, auditedAt);
    });
    post.immediate();
    const row = this.database.prepare(
      "SELECT id FROM ledger_transactions WHERE source_key = ?",
    ).get(`manual_journal:${input.sourceId}`) as { id: string } | undefined;
    if (!row) throw new FabricServiceError("VALIDATION", "A manual journal entry cannot have a zero amount.");
    return this.getEntry(row.id);
  }

  postOpeningBalances(input: {
    sourceId: string;
    date: string;
    lines: JournalLineInput[];
  }): JournalEntry {
    const createdAt = `${input.date}T12:00:00.000Z`;
    const auditedAt = new Date().toISOString();
    const post = this.database.transaction(() => {
      postJournal(
        this.database,
        "opening_balance",
        "Opening balances",
        createdAt,
        input.lines,
        "Owner",
        input.sourceId,
      );
      if (!this.database.prepare(
        "SELECT id FROM ledger_transactions WHERE source_key = ?",
      ).get(`opening_balance:${input.sourceId}`)) {
        throw new FabricServiceError("VALIDATION", "Opening balances cannot have a zero amount.");
      }
      writeAuditLog(this.database, "Owner", "opening_balance", "journal", input.sourceId, "Opening balances", auditedAt);
    });
    post.immediate();
    const row = this.database.prepare(
      "SELECT id FROM ledger_transactions WHERE source_key = ?",
    ).get(`opening_balance:${input.sourceId}`) as { id: string } | undefined;
    if (!row) throw new FabricServiceError("VALIDATION", "Opening balances cannot have a zero amount.");
    return this.getEntry(row.id);
  }

  reverseEntry(id: string, reason: string): JournalEntry {
    const original = this.database.prepare(`
      SELECT id, transaction_type, reference, created_at, reversal_of_transaction_id
      FROM ledger_transactions WHERE id = ?
    `).get(id) as {
      id: string;
      transaction_type: string;
      reference: string;
      created_at: string;
      reversal_of_transaction_id: string | null;
    } | undefined;
    if (!original) throw new FabricServiceError("NOT_FOUND", "Journal entry not found.");
    if (original.transaction_type !== "manual_journal" && original.transaction_type !== "opening_balance") {
      throw new FabricServiceError(
        "CONFLICT",
        "Reverse the source transaction through its domain service.",
      );
    }
    if (original.reversal_of_transaction_id) {
      throw new FabricServiceError("CONFLICT", "A reversal entry cannot itself be reversed.");
    }
    if (this.database.prepare(
      "SELECT id FROM ledger_transactions WHERE reversal_of_transaction_id = ?",
    ).get(id)) {
      throw new FabricServiceError("CONFLICT", "This journal entry has already been reversed.");
    }
    const lines = (this.database.prepare(`
      SELECT account_code, debit_minor, credit_minor, supplier_id, customer_id
      FROM ledger_postings WHERE transaction_id = ? ORDER BY rowid
    `).all(id) as Array<{
      account_code: string;
      debit_minor: number;
      credit_minor: number;
      supplier_id: string | null;
      customer_id: string | null;
    }>).map((line) => ({
      accountCode: line.account_code,
      debitMinor: line.credit_minor,
      creditMinor: line.debit_minor,
      ...(line.supplier_id ? { supplierId: line.supplier_id } : {}),
      ...(line.customer_id ? { customerId: line.customer_id } : {}),
    }));
    const now = new Date().toISOString();
    const reverse = this.database.transaction(() => {
      postJournal(
        this.database,
        "reversal",
        original.reference,
        now,
        lines,
        "Owner",
        `reversal:${id}`,
        id,
        reason,
      );
      writeAuditLog(this.database, "Owner", "journal_reversal", "journal", id, reason, now);
    });
    reverse.immediate();
    const row = this.database.prepare(
      "SELECT id FROM ledger_transactions WHERE reversal_of_transaction_id = ?",
    ).get(id) as { id: string };
    return this.getEntry(row.id);
  }

  reconcile(): AccountingReconciliation {
    const checks: ReconciliationCheck[] = [];
    const addCheck = (name: string, expectedMinor: number, actualMinor: number) => {
      checks.push({
        name,
        expectedMinor,
        actualMinor,
        differenceMinor: actualMinor - expectedMinor,
        isBalanced: actualMinor === expectedMinor,
      });
    };
    const trialBalance = this.trialBalance("9999-12-31");
    addCheck("Trial balance debits and credits", trialBalance.totalDebitsMinor, trialBalance.totalCreditsMinor);
    const unbalancedEntries = this.database.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT transaction_id FROM ledger_postings
        GROUP BY transaction_id HAVING SUM(debit_minor) != SUM(credit_minor)
      )
    `).get() as { count: number };
    addCheck("Journal entry balance", 0, unbalancedEntries.count);
    const receivables = this.database.prepare(`
      SELECT
        COALESCE(SUM(debit_minor - credit_minor), 0) AS control_minor,
        COALESCE(SUM(CASE WHEN customer_id IS NOT NULL THEN debit_minor - credit_minor ELSE 0 END), 0) AS subledger_minor
      FROM ledger_postings WHERE account_code = '1300'
    `).get() as { control_minor: number; subledger_minor: number };
    addCheck("Accounts receivable subledger", receivables.control_minor, receivables.subledger_minor);
    const payables = this.database.prepare(`
      SELECT
        COALESCE(SUM(credit_minor - debit_minor), 0) AS control_minor,
        COALESCE(SUM(CASE WHEN supplier_id IS NOT NULL THEN credit_minor - debit_minor ELSE 0 END), 0) AS subledger_minor
      FROM ledger_postings WHERE account_code = '2100'
    `).get() as { control_minor: number; subledger_minor: number };
    addCheck("Accounts payable subledger", payables.control_minor, payables.subledger_minor);
    const inventory = this.database.prepare(`
      SELECT
        COALESCE((SELECT SUM(debit_minor - credit_minor) FROM ledger_postings WHERE account_code = '1200'), 0) AS ledger_minor,
        COALESCE((SELECT SUM(stock_value_minor) FROM fabrics), 0) AS stock_minor
    `).get() as { ledger_minor: number; stock_minor: number };
    addCheck("Inventory valuation", inventory.stock_minor, inventory.ledger_minor);
    return { checks, isBalanced: checks.every((check) => check.isBalanced) };
  }

  private mapEntry(row: JournalTransactionRow & { reversed_by?: string | null }): JournalEntry {
    const lines = this.database.prepare(`
      SELECT p.account_code, a.name AS account_name, p.debit_minor, p.credit_minor,
        p.supplier_id, p.customer_id
      FROM ledger_postings p JOIN ledger_accounts a ON a.code = p.account_code
      WHERE p.transaction_id = ? ORDER BY p.rowid
    `).all(row.id) as JournalPostingRow[];
    return {
      id: row.id,
      transactionType: row.transaction_type,
      reference: row.reference,
      authorizedUser: row.authorized_user,
      createdAt: row.created_at,
      ...(row.period_id ? { periodId: row.period_id } : {}),
      ...(row.reversal_of_transaction_id
        ? { reversalOfTransactionId: row.reversal_of_transaction_id }
        : {}),
      ...(row.reversal_reason ? { reversalReason: row.reversal_reason } : {}),
      ...(row.reversed_by ? { reversedByTransactionId: row.reversed_by } : {}),
      lines: lines.map((line) => ({
        accountCode: line.account_code,
        accountName: line.account_name,
        debitMinor: line.debit_minor,
        creditMinor: line.credit_minor,
        ...(line.supplier_id ? { supplierId: line.supplier_id } : {}),
        ...(line.customer_id ? { customerId: line.customer_id } : {}),
      })),
    };
  }
}
