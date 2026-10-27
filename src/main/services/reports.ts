import type Database from "better-sqlite3";
import type { AnalyticsReportInput } from "../../shared/contracts";
import type {
  AnalyticsReport,
  AnalyticsReportColumn,
  AnalyticsReportReconciliation,
} from "../../shared/types";
import { FabricServiceError } from "./errors";

type ReportRow = Record<string, string | number>;
type QueryReport = {
  columns: AnalyticsReportColumn[];
  rows: ReportRow[];
  totals: Record<string, number>;
  reconciliations?: AnalyticsReportReconciliation[];
};

function reconciliation(
  name: string,
  expectedMinor: number,
  actualMinor: number,
): AnalyticsReportReconciliation {
  return {
    name,
    expectedMinor,
    actualMinor,
    differenceMinor: expectedMinor - actualMinor,
    isBalanced: expectedMinor === actualMinor,
  };
}

export class ReportsService {
  constructor(private readonly database: Database.Database) {}

  run(input: Omit<AnalyticsReportInput, "ownerPin">): AnalyticsReport {
    const report = this.buildReport(input);
    const query = input.search.toLocaleLowerCase();
    const filteredRows = query
      ? report.rows.filter((row) =>
        Object.values(row).some((value) => String(value).toLocaleLowerCase().includes(query)),
      )
      : report.rows;
    const offset = (input.page - 1) * input.pageSize;
    return {
      reportType: input.reportType,
      from: input.from,
      to: input.to,
      page: input.page,
      pageSize: input.pageSize,
      totalRows: filteredRows.length,
      columns: report.columns,
      rows: filteredRows.slice(offset, offset + input.pageSize),
      totals: report.totals,
      reconciliations: report.reconciliations ?? [],
    };
  }

  private buildReport(input: Omit<AnalyticsReportInput, "ownerPin">): QueryReport {
    switch (input.reportType) {
      case "daily_sales":
        return this.dailySales(input.from, input.to);
      case "purchases":
        return this.purchases(input.from, input.to);
      case "stock_summary":
        return this.stockSummary(input.to);
      case "gross_profit":
        return this.profitReport(input.from, input.to, true);
      case "profit_loss":
        return this.profitReport(input.from, input.to, false);
      case "customer_balances":
        return this.customerBalances(input.to);
      case "supplier_balances":
        return this.supplierBalances(input.to);
      case "trial_balance":
        return this.trialBalance(input.to);
      case "cashbook":
        return this.ledger(input.from, input.to, "1000");
      case "general_ledger":
        if (!input.accountCode) {
          throw new FabricServiceError("VALIDATION", "Choose an account for the general ledger report.");
        }
        return this.ledger(input.from, input.to, input.accountCode);
    }
    throw new FabricServiceError("VALIDATION", "Unsupported analytics report.");
  }

  private dailySales(from: string, to: string): QueryReport {
    const rows = this.database.prepare(`
      SELECT i.invoice_number AS invoice, substr(i.created_at, 1, 10) AS date,
        COALESCE(c.code || ' · ' || c.name, 'Walk-in') AS customer,
        (SELECT COALESCE(SUM(item.line_total_minor), 0)
         FROM invoice_items item WHERE item.invoice_id = i.id) AS gross_minor,
        i.discount_minor, i.total_minor AS net_minor,
        i.amount_received_minor AS received_minor,
        i.total_minor - i.amount_received_minor AS balance_minor
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      WHERE substr(i.created_at, 1, 10) >= ? AND substr(i.created_at, 1, 10) <= ?
      ORDER BY i.created_at DESC
    `).all(from, to) as Array<{
      invoice: string;
      date: string;
      customer: string;
      gross_minor: number;
      discount_minor: number;
      net_minor: number;
      received_minor: number;
      balance_minor: number;
    }>;
    const grossSalesMinor = rows.reduce((sum, row) => sum + row.gross_minor, 0);
    const netSalesMinor = rows.reduce((sum, row) => sum + row.net_minor, 0);
    return {
      columns: [
        { key: "date", label: "Date", format: "text" },
        { key: "invoice", label: "Invoice", format: "text" },
        { key: "customer", label: "Customer", format: "text" },
        { key: "gross_minor", label: "Gross sales", format: "money" },
        { key: "discount_minor", label: "Discount", format: "money" },
        { key: "net_minor", label: "Net sales", format: "money" },
        { key: "received_minor", label: "Received at sale", format: "money" },
        { key: "balance_minor", label: "Credit at sale", format: "money" },
      ],
      rows: rows.map((row) => ({
        date: row.date,
        invoice: row.invoice,
        customer: row.customer,
        gross_minor: row.gross_minor,
        discount_minor: row.discount_minor,
        net_minor: row.net_minor,
        received_minor: row.received_minor,
        balance_minor: row.balance_minor,
      })),
      totals: {
        grossSalesMinor,
        returnsMinor: 0,
        netSalesMinor,
        discountMinor: rows.reduce((sum, row) => sum + row.discount_minor, 0),
        receivedMinor: rows.reduce((sum, row) => sum + row.received_minor, 0),
        balanceMinor: rows.reduce((sum, row) => sum + row.balance_minor, 0),
      },
    };
  }

  private purchases(from: string, to: string): QueryReport {
    const rows = this.database.prepare(`
      SELECT p.purchase_date AS date, p.bill_number AS bill, s.code || ' · ' || s.name AS supplier,
        (SELECT COALESCE(SUM(i.quantity_mm), 0) / 1000.0
         FROM supplier_purchase_items i WHERE i.purchase_id = p.id) AS quantity_meters,
        p.total_minor, p.paid_minor, p.total_minor - p.paid_minor AS due_minor
      FROM supplier_purchases p JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.purchase_date >= ? AND p.purchase_date <= ?
      ORDER BY p.purchase_date DESC, p.created_at DESC
    `).all(from, to) as Array<{
      date: string;
      bill: string;
      supplier: string;
      quantity_meters: number;
      total_minor: number;
      paid_minor: number;
      due_minor: number;
    }>;
    return {
      columns: [
        { key: "date", label: "Date", format: "text" },
        { key: "bill", label: "Supplier bill", format: "text" },
        { key: "supplier", label: "Supplier", format: "text" },
        { key: "quantity_meters", label: "Quantity (m)", format: "number" },
        { key: "total_minor", label: "Purchase cost", format: "money" },
        { key: "paid_minor", label: "Paid", format: "money" },
        { key: "due_minor", label: "Balance", format: "money" },
      ],
      rows: rows.map((row) => ({ ...row })),
      totals: {
        quantityMeters: rows.reduce((sum, row) => sum + row.quantity_meters, 0),
        purchaseCostMinor: rows.reduce((sum, row) => sum + row.total_minor, 0),
        paidMinor: rows.reduce((sum, row) => sum + row.paid_minor, 0),
        dueMinor: rows.reduce((sum, row) => sum + row.due_minor, 0),
      },
    };
  }

  private stockSummary(asOf: string): QueryReport {
    const rows = this.database.prepare(`
      SELECT sku, name, stock_qty_mm / 1000.0 AS quantity_meters, stock_value_minor,
        CASE WHEN stock_qty_mm = 0 THEN purchase_cost_minor
          ELSE ROUND(stock_value_minor * 1000.0 / stock_qty_mm) END AS unit_cost_minor
      FROM fabrics ORDER BY sku COLLATE NOCASE
    `).all() as Array<{
      sku: string;
      name: string;
      quantity_meters: number;
      stock_value_minor: number;
      unit_cost_minor: number;
    }>;
    const inventoryControl = this.accountBalance("1200", asOf);
    const stockValueMinor = rows.reduce((sum, row) => sum + row.stock_value_minor, 0);
    return {
      columns: [
        { key: "sku", label: "SKU", format: "text" },
        { key: "name", label: "Fabric quality", format: "text" },
        { key: "quantity_meters", label: "Available (m)", format: "number" },
        { key: "unit_cost_minor", label: "Average cost / m", format: "money" },
        { key: "stock_value_minor", label: "Stock value", format: "money" },
      ],
      rows: rows.map((row) => ({ ...row })),
      totals: {
        quantityMeters: rows.reduce((sum, row) => sum + row.quantity_meters, 0),
        stockValueMinor,
      },
      reconciliations: [reconciliation("Stock valuation to Inventory control", stockValueMinor, inventoryControl)],
    };
  }

  private profitReport(from: string, to: string, grossOnly: boolean): QueryReport {
    const revenueMinor = this.accountPeriodBalance("income", from, to);
    const costOfGoodsSoldMinor = this.accountPeriodBalance("expense", from, to, undefined, "5000");
    const operatingExpensesMinor = this.accountPeriodBalance("expense", from, to, "5000");
    const grossProfitMinor = revenueMinor - costOfGoodsSoldMinor;
    const netProfitMinor = grossProfitMinor - operatingExpensesMinor;
    const rows = grossOnly
      ? [
        { item: "Net sales revenue", amount_minor: revenueMinor },
        { item: "Cost of goods sold", amount_minor: -costOfGoodsSoldMinor },
        { item: "Gross profit", amount_minor: grossProfitMinor },
      ]
      : [
        { item: "Net sales revenue", amount_minor: revenueMinor },
        { item: "Cost of goods sold", amount_minor: -costOfGoodsSoldMinor },
        { item: "Gross profit", amount_minor: grossProfitMinor },
        { item: "Operating expenses", amount_minor: -operatingExpensesMinor },
        { item: "Net profit", amount_minor: netProfitMinor },
      ];
    return {
      columns: [
        { key: "item", label: "Account", format: "text" },
        { key: "amount_minor", label: "Amount", format: "money" },
      ],
      rows,
      totals: { revenueMinor, costOfGoodsSoldMinor, grossProfitMinor, operatingExpensesMinor, netProfitMinor },
    };
  }

  private accountPeriodBalance(
    accountType: string,
    from: string,
    to: string,
    excludeCode?: string,
    onlyCode?: string,
  ): number {
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN a.normal_balance = 'credit' THEN p.credit_minor - p.debit_minor
             ELSE p.debit_minor - p.credit_minor END
      ), 0) AS balance_minor
      FROM ledger_postings p
      JOIN ledger_transactions t ON t.id = p.transaction_id
      JOIN ledger_accounts a ON a.code = p.account_code
      WHERE a.account_type = ? AND (? IS NULL OR a.code != ?)
        AND (? IS NULL OR a.code = ?)
        AND substr(t.created_at, 1, 10) >= ? AND substr(t.created_at, 1, 10) <= ?
    `).get(
      accountType, excludeCode ?? null, excludeCode ?? null,
      onlyCode ?? null, onlyCode ?? null, from, to,
    ) as { balance_minor: number };
    return row.balance_minor;
  }

  private customerBalances(asOf: string): QueryReport {
    const customers = this.database.prepare(`
      SELECT c.id, c.code, c.name,
        COALESCE(SUM(p.debit_minor - p.credit_minor), 0) AS balance_minor
      FROM customers c
      LEFT JOIN ledger_postings p ON p.customer_id = c.id AND p.account_code = '1300'
      LEFT JOIN ledger_transactions t ON t.id = p.transaction_id
        AND substr(t.created_at, 1, 10) <= ?
      WHERE t.id IS NOT NULL OR p.id IS NULL
      GROUP BY c.id ORDER BY c.name COLLATE NOCASE
    `).all(asOf) as Array<{ id: string; code: string; name: string; balance_minor: number }>;
    const customerRows = customers.map((customer) => {
      const overdue = this.customerOverdue(customer.id, asOf);
      return {
        code: customer.code,
        customer: customer.name,
        balance_minor: customer.balance_minor,
        overdue_minor: overdue,
      };
    });
    const receivableMinor = this.accountBalance("1300", asOf);
    const customerTotalMinor = customerRows.reduce((sum, row) => sum + row.balance_minor, 0);
    return {
      columns: [
        { key: "code", label: "Code", format: "text" },
        { key: "customer", label: "Customer", format: "text" },
        { key: "balance_minor", label: "Outstanding", format: "money" },
        { key: "overdue_minor", label: "Overdue", format: "money" },
      ],
      rows: customerRows,
      totals: {
        receivableMinor: customerTotalMinor,
        overdueMinor: customerRows.reduce((sum, row) => sum + row.overdue_minor, 0),
      },
      reconciliations: [reconciliation("Customer balances to Accounts Receivable", receivableMinor, customerTotalMinor)],
    };
  }

  private customerOverdue(customerId: string, asOf: string): number {
    const customer = this.database.prepare(`
      SELECT COALESCE(SUM(p.debit_minor - p.credit_minor), 0) AS balance_minor
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = '1300' AND p.customer_id = ?
        AND substr(t.created_at, 1, 10) <= ?
    `).get(customerId, asOf) as { balance_minor: number };
    let remaining = Math.max(0, customer.balance_minor);
    const invoices = this.database.prepare(`
      SELECT i.id, i.total_minor - i.amount_received_minor AS original_due_minor,
        i.created_at, i.payment_terms_days
      FROM invoices i
      WHERE i.customer_id = ? AND substr(i.created_at, 1, 10) <= ?
      ORDER BY i.created_at
    `).all(customerId, asOf) as Array<{
      id: string;
      original_due_minor: number;
      created_at: string;
      payment_terms_days: number;
    }>;
    let overdueMinor = 0;
    for (const invoice of invoices) {
      const dueDate = new Date(invoice.created_at);
      dueDate.setUTCDate(dueDate.getUTCDate() + invoice.payment_terms_days);
      const isOverdue = dueDate.toISOString().slice(0, 10) < asOf;
      const linkedReceipts = this.database.prepare(`
        SELECT COALESCE(SUM(r.receivable_minor), 0) AS applied_minor
        FROM customer_receipts r
        WHERE r.invoice_id = ? AND substr(r.created_at, 1, 10) <= ?
          AND (r.reversed_at IS NULL OR substr(r.reversed_at, 1, 10) > ?)
      `).get(invoice.id, asOf, asOf) as { applied_minor: number };
      const due = Math.max(0, invoice.original_due_minor - linkedReceipts.applied_minor);
      const allocated = Math.min(remaining, due);
      if (isOverdue) overdueMinor += allocated;
      remaining -= allocated;
    }
    return overdueMinor;
  }

  private supplierBalances(asOf: string): QueryReport {
    const rows = this.database.prepare(`
      SELECT s.code, s.name AS supplier,
        COALESCE(SUM(p.credit_minor - p.debit_minor), 0) AS balance_minor
      FROM suppliers s
      LEFT JOIN ledger_postings p ON p.supplier_id = s.id AND p.account_code = '2100'
      LEFT JOIN ledger_transactions t ON t.id = p.transaction_id
        AND substr(t.created_at, 1, 10) <= ?
      WHERE t.id IS NOT NULL OR p.id IS NULL
      GROUP BY s.id ORDER BY s.name COLLATE NOCASE
    `).all(asOf) as Array<{ code: string; supplier: string; balance_minor: number }>;
    return {
      columns: [
        { key: "code", label: "Code", format: "text" },
        { key: "supplier", label: "Supplier", format: "text" },
        { key: "balance_minor", label: "Outstanding payable", format: "money" },
      ],
      rows: rows.map((row) => ({ ...row })),
      totals: {
        payableMinor: rows.reduce((sum, row) => sum + row.balance_minor, 0),
      },
      reconciliations: [reconciliation(
        "Supplier balances to Accounts Payable",
        this.accountBalance("2100", asOf, true),
        rows.reduce((sum, row) => sum + row.balance_minor, 0),
      )],
    };
  }

  private trialBalance(asOf: string): QueryReport {
    const rows = this.database.prepare(`
      SELECT a.code, a.name, a.account_type,
        COALESCE(SUM(CASE WHEN t.id IS NOT NULL
          THEN p.debit_minor - p.credit_minor ELSE 0 END), 0) AS balance_minor
      FROM ledger_accounts a
      LEFT JOIN ledger_postings p ON p.account_code = a.code
      LEFT JOIN ledger_transactions t ON t.id = p.transaction_id
        AND substr(t.created_at, 1, 10) <= ?
      GROUP BY a.code ORDER BY a.code
    `).all(asOf) as Array<{
      code: string;
      name: string;
      account_type: string;
      balance_minor: number;
    }>;
    const mapped = rows.map((row) => ({
      code: row.code,
      account: row.name,
      type: row.account_type,
      debit_minor: Math.max(row.balance_minor, 0),
      credit_minor: Math.max(-row.balance_minor, 0),
    }));
    return {
      columns: [
        { key: "code", label: "Code", format: "text" },
        { key: "account", label: "Account", format: "text" },
        { key: "type", label: "Type", format: "text" },
        { key: "debit_minor", label: "Debit", format: "money" },
        { key: "credit_minor", label: "Credit", format: "money" },
      ],
      rows: mapped,
      totals: {
        debitMinor: mapped.reduce((sum, row) => sum + row.debit_minor, 0),
        creditMinor: mapped.reduce((sum, row) => sum + row.credit_minor, 0),
      },
    };
  }

  private ledger(from: string, to: string, accountCode: string): QueryReport {
    const account = this.database.prepare(
      "SELECT code, name FROM ledger_accounts WHERE code = ?",
    ).get(accountCode) as { code: string; name: string } | undefined;
    if (!account) throw new FabricServiceError("NOT_FOUND", "Ledger account not found.");
    const rows = this.database.prepare(`
      SELECT substr(t.created_at, 1, 10) AS date, t.transaction_type AS type,
        t.reference, p.debit_minor, p.credit_minor
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = ? AND substr(t.created_at, 1, 10) >= ?
        AND substr(t.created_at, 1, 10) <= ?
      ORDER BY t.created_at, t.rowid, p.rowid
    `).all(accountCode, from, to) as Array<{
      date: string;
      type: string;
      reference: string;
      debit_minor: number;
      credit_minor: number;
    }>;
    let balanceMinor = this.accountBalance(accountCode, from, false, true);
    const mapped = rows.map((row) => {
      balanceMinor += row.debit_minor - row.credit_minor;
      return {
        date: row.date,
        type: row.type,
        reference: row.reference,
        debit_minor: row.debit_minor,
        credit_minor: row.credit_minor,
        balance_minor: balanceMinor,
      };
    });
    return {
      columns: [
        { key: "date", label: "Date", format: "text" },
        { key: "type", label: "Type", format: "text" },
        { key: "reference", label: "Reference", format: "text" },
        { key: "debit_minor", label: "Debit", format: "money" },
        { key: "credit_minor", label: "Credit", format: "money" },
        { key: "balance_minor", label: "Balance", format: "money" },
      ],
      rows: mapped,
      totals: {
        openingBalanceMinor: this.accountBalance(accountCode, from, false, true),
        debitMinor: rows.reduce((sum, row) => sum + row.debit_minor, 0),
        creditMinor: rows.reduce((sum, row) => sum + row.credit_minor, 0),
        closingBalanceMinor: balanceMinor,
      },
    };
  }

  private accountBalance(
    accountCode: string,
    asOf: string,
    normalCredit = false,
    before = false,
  ): number {
    const comparison = before ? "<" : "<=";
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(p.debit_minor - p.credit_minor), 0) AS balance_minor
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = ? AND substr(t.created_at, 1, 10) ${comparison} ?
    `).get(accountCode, asOf) as { balance_minor: number };
    return normalCredit ? -row.balance_minor : row.balance_minor;
  }
}
