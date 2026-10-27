import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CustomerInput,
  CustomerListInput,
  CustomerReceiptInput,
  CustomerStatementInput,
  UpdateCustomerInput,
} from "../../shared/contracts";
import type {
  Customer,
  CustomerDetails,
  CustomerReceipt,
  CustomerStatement,
  Invoice,
} from "../../shared/types";
import { FabricServiceError } from "./errors";
import { postJournal } from "./accounting";

interface CustomerRow {
  id: string;
  code: string;
  name: string;
  phone: string;
  address: string;
  credit_limit_minor: number;
  payment_terms_days: number;
  active: number;
  outstanding_minor: number;
  sales_count: number;
  receipt_count: number;
  created_at: string;
  updated_at: string;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  total_minor: number;
  created_at: string;
  customer_id?: string | null;
  customer_code?: string | null;
  customer_name?: string | null;
}

interface InvoiceItemRow {
  id: string;
  fabric_id: string;
  sku_snapshot: string;
  name_snapshot: string;
  quantity_mm: number;
  unit_price_minor: number;
  line_total_minor: number;
}

interface ReceiptRow {
  id: string;
  receipt_number: string;
  account_code: string;
  amount_minor: number;
  reference: string;
  note: string;
  created_at: string;
}

function mapCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    address: row.address,
    creditLimitMinor: row.credit_limit_minor,
    paymentTermsDays: row.payment_terms_days,
    active: row.active === 1,
    outstandingMinor: row.outstanding_minor,
    salesCount: row.sales_count,
    receiptCount: row.receipt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInvoice(row: InvoiceRow, items: InvoiceItemRow[]): Invoice {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    totalMinor: row.total_minor,
    createdAt: row.created_at,
    customerId: row.customer_id ?? undefined,
    customerCode: row.customer_code ?? undefined,
    customerName: row.customer_name ?? undefined,
    items: items.map((item) => ({
      id: item.id,
      fabricId: item.fabric_id,
      sku: item.sku_snapshot,
      name: item.name_snapshot,
      quantityMm: item.quantity_mm,
      unitPriceMinor: item.unit_price_minor,
      lineTotalMinor: item.line_total_minor,
    })),
  };
}

export class CustomerService {
  constructor(private readonly database: Database.Database) {}

  list(input: CustomerListInput): Customer[] {
    const query = `%${input.query}%`;
    const rows = this.database.prepare(`
      SELECT c.*,
        COALESCE((
          SELECT SUM(p.debit_minor - p.credit_minor)
          FROM ledger_postings p WHERE p.account_code = '1300' AND p.customer_id = c.id
        ), 0) AS outstanding_minor,
        (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id) AS sales_count,
        (SELECT COUNT(*) FROM customer_receipts r WHERE r.customer_id = c.id) AS receipt_count
      FROM customers c
      WHERE (? = '%%' OR c.code LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)
        AND (? = 1 OR c.active = 1)
      ORDER BY c.name COLLATE NOCASE
    `).all(query, query, query, query, input.includeInactive ? 1 : 0) as CustomerRow[];
    return rows.map(mapCustomer);
  }

  create(input: Omit<CustomerInput, "ownerPin">, authorizedUser: string): Customer {
    const id = randomUUID();
    const now = new Date().toISOString();
    const openingBalance = Math.round(input.openingBalance * 100);
    if (openingBalance > 0 && !authorizedUser.trim()) {
      throw new FabricServiceError("AUTHORIZATION", "An authorized user is required for customer opening balances.");
    }
    const transaction = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO customers (
          id, code, name, phone, address, credit_limit_minor, payment_terms_days,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.code, input.name, input.phone, input.address,
        Math.round(input.creditLimit * 100), input.paymentTermsDays, now, now,
      );
      if (openingBalance > 0) {
        postJournal(this.database, "customer_opening_balance", `Opening balance ${input.code}`, now, [
          { accountCode: "1300", debitMinor: openingBalance, customerId: id },
          { accountCode: "3000", creditMinor: openingBalance },
        ], authorizedUser);
      }
    });
    try {
      transaction.immediate();
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new FabricServiceError("CONFLICT", "That customer code is already in use.");
      }
      throw error;
    }
    return this.getCustomer(id);
  }

  update(input: UpdateCustomerInput): Customer {
    const result = this.database.prepare(`
      UPDATE customers SET code = ?, name = ?, phone = ?, address = ?,
        credit_limit_minor = ?, payment_terms_days = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.code, input.name, input.phone, input.address,
      Math.round(input.creditLimit * 100), input.paymentTermsDays,
      new Date().toISOString(), input.id,
    );
    if (result.changes === 0) throw new FabricServiceError("NOT_FOUND", "Customer not found.");
    return this.getCustomer(input.id);
  }

  get(id: string): CustomerDetails {
    const customer = this.getCustomer(id);
    const invoices = this.database.prepare(`
      SELECT i.id, i.invoice_number, i.total_minor, i.created_at,
             i.customer_id, c.code AS customer_code, c.name AS customer_name
      FROM invoices i JOIN customers c ON c.id = i.customer_id
      WHERE i.customer_id = ? ORDER BY i.created_at DESC
    `).all(id) as InvoiceRow[];
    const sales = invoices.map((invoice) => {
      const items = this.database.prepare(`
        SELECT id, fabric_id, sku_snapshot, name_snapshot, quantity_mm, unit_price_minor, line_total_minor
        FROM invoice_items WHERE invoice_id = ? ORDER BY rowid
      `).all(invoice.id) as InvoiceItemRow[];
      return mapInvoice(invoice, items);
    });
    const receiptRows = this.database.prepare(`
      SELECT id, receipt_number, account_code, amount_minor, reference, note, created_at
      FROM customer_receipts WHERE customer_id = ? ORDER BY created_at DESC
    `).all(id) as ReceiptRow[];
    const receipts: CustomerReceipt[] = receiptRows.map((row) => ({
      id: row.id,
      receiptNumber: row.receipt_number,
      account: row.account_code === "1010" ? "bank" : "cash",
      amountMinor: row.amount_minor,
      reference: row.reference,
      note: row.note,
      createdAt: row.created_at,
    }));
    return { customer, sales, receipts, statement: null };
  }

  receive(input: CustomerReceiptInput): CustomerDetails {
    const id = randomUUID();
    const receiptNumber = `CR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${id.slice(0, 6).toUpperCase()}`;
    const amount = Math.round(input.amount * 100);
    const now = new Date().toISOString();
    const accountCode = input.account === "bank" ? "1010" : "1000";
    const transaction = this.database.transaction(() => {
      this.requireCustomer(input.customerId);
      const outstanding = this.database.prepare(`
        SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS balance
        FROM ledger_postings WHERE account_code = '1300' AND customer_id = ?
      `).get(input.customerId) as { balance: number };
      if (amount > outstanding.balance) {
        throw new FabricServiceError("VALIDATION", "Receipt cannot exceed the customer's outstanding receivable.");
      }
      this.database.prepare(`
        INSERT INTO customer_receipts (
          id, customer_id, receipt_number, account_code, amount_minor, reference, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.customerId, receiptNumber, accountCode, amount,
        input.reference, input.note, now,
      );
      postJournal(this.database, "customer_receipt", receiptNumber, now, [
        { accountCode, debitMinor: amount },
        { accountCode: "1300", customerId: input.customerId, creditMinor: amount },
      ]);
    });
    transaction.immediate();
    return this.get(input.customerId);
  }

  statement(input: CustomerStatementInput): CustomerStatement {
    this.requireCustomer(input.customerId);
    const start = `${input.from}T00:00:00.000Z`;
    const end = `${input.to}T23:59:59.999Z`;
    const before = this.database.prepare(`
      SELECT COALESCE(SUM(p.debit_minor - p.credit_minor), 0) AS balance
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = '1300' AND p.customer_id = ? AND t.created_at < ?
    `).get(input.customerId, start) as { balance: number };
    const rows = this.database.prepare(`
      SELECT t.transaction_type, t.reference, t.created_at, p.debit_minor, p.credit_minor
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = '1300' AND p.customer_id = ?
        AND t.created_at >= ? AND t.created_at <= ?
      ORDER BY t.created_at, t.rowid, p.rowid
    `).all(input.customerId, start, end) as Array<{
      transaction_type: string;
      reference: string;
      created_at: string;
      debit_minor: number;
      credit_minor: number;
    }>;
    let balance = before.balance;
    const lines = rows.map((row) => {
      balance += row.debit_minor - row.credit_minor;
      return {
        transactionType: row.transaction_type,
        reference: row.reference,
        createdAt: row.created_at,
        debitMinor: row.debit_minor,
        creditMinor: row.credit_minor,
        balanceMinor: balance,
      };
    });
    return {
      customerId: input.customerId,
      from: input.from,
      to: input.to,
      openingBalanceMinor: before.balance,
      closingBalanceMinor: balance,
      lines,
    };
  }

  private getCustomer(id: string): Customer {
    const row = this.database.prepare(`
      SELECT c.*,
        COALESCE((
          SELECT SUM(p.debit_minor - p.credit_minor)
          FROM ledger_postings p WHERE p.account_code = '1300' AND p.customer_id = c.id
        ), 0) AS outstanding_minor,
        (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id) AS sales_count,
        (SELECT COUNT(*) FROM customer_receipts r WHERE r.customer_id = c.id) AS receipt_count
      FROM customers c WHERE c.id = ?
    `).get(id) as CustomerRow | undefined;
    if (!row) throw new FabricServiceError("NOT_FOUND", "Customer not found.");
    return mapCustomer(row);
  }

  private requireCustomer(id: string): void {
    if (!this.database.prepare("SELECT id FROM customers WHERE id = ?").get(id)) {
      throw new FabricServiceError("NOT_FOUND", "Customer not found.");
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE";
  }
}
