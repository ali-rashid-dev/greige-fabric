import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CustomerInput,
  CustomerListInput,
  CustomerReceiptInput,
  CustomerReceiptReversalInput,
  CustomerStatementInput,
  UpdateCustomerInput,
} from "../../shared/contracts";
import type {
  Customer,
  CustomerDetails,
  CustomerReceipt,
  CustomerStatement,
  Invoice,
  PaymentAccount,
} from "../../shared/types";
import { FabricServiceError } from "./errors";
import { postJournal } from "./accounting";
import { writeAuditLog } from "./audit";

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
  advance_minor: number;
  sales_count: number;
  receipt_count: number;
  created_at: string;
  updated_at: string;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  total_minor: number;
  discount_minor: number;
  amount_received_minor: number;
  returned_minor: number;
  payment_account_code: string;
  created_at: string;
  customer_id?: string | null;
  customer_code?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_address?: string | null;
  payment_terms_days?: number | null;
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
  invoice_id: string | null;
  invoice_number: string | null;
  receipt_number: string;
  account_code: string;
  account_name: string;
  amount_minor: number;
  receivable_minor: number;
  advance_minor: number;
  reference: string;
  note: string;
  created_at: string;
  reversed_at: string | null;
  reversal_reason: string;
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
    advanceMinor: row.advance_minor,
    salesCount: row.sales_count,
    receiptCount: row.receipt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInvoice(row: InvoiceRow, items: InvoiceItemRow[]): Invoice {
  const subtotalMinor = items.reduce((total, item) => total + item.line_total_minor, 0);
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    subtotalMinor,
    discountMinor: row.discount_minor,
    totalMinor: row.total_minor,
    amountReceivedMinor: row.amount_received_minor,
    dueMinor: Math.max(0, row.total_minor - row.amount_received_minor - row.returned_minor),
    paymentAccount: row.payment_account_code === "1010" ? "bank" : "cash",
    createdAt: row.created_at,
    customerId: row.customer_id ?? undefined,
    customerCode: row.customer_code ?? undefined,
    customerName: row.customer_name ?? undefined,
    customerPhone: row.customer_phone ?? undefined,
    customerAddress: row.customer_address ?? undefined,
    paymentTermsDays: row.payment_terms_days ?? undefined,
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
        COALESCE((
          SELECT SUM(p.credit_minor - p.debit_minor)
          FROM ledger_postings p WHERE p.account_code = '2200' AND p.customer_id = c.id
        ), 0) AS advance_minor,
        (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = c.id) AS sales_count,
        (SELECT COUNT(*) FROM customer_receipts r WHERE r.customer_id = c.id) AS receipt_count
      FROM customers c
      WHERE (? = '%%' OR c.code LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)
        AND (? = 1 OR c.active = 1)
      ORDER BY c.name COLLATE NOCASE
    `).all(query, query, query, query, input.includeInactive ? 1 : 0) as CustomerRow[];
    return rows.map(mapCustomer);
  }

  create(input: CustomerInput, authorizedUser: string): Customer {
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
        ], authorizedUser, id);
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
    try {
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
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new FabricServiceError("CONFLICT", "That customer code is already in use.");
      }
      throw error;
    }
    return this.getCustomer(input.id);
  }

  get(id: string): CustomerDetails {
    const customer = this.getCustomer(id);
    const invoices = this.database.prepare(`
      SELECT i.id, i.invoice_number, i.total_minor, i.discount_minor,
             i.amount_received_minor, i.payment_account_code, i.created_at,
             i.returned_minor,
             i.customer_id, c.code AS customer_code, c.name AS customer_name,
             i.customer_phone, i.customer_address, i.payment_terms_days
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
      SELECT r.id, r.invoice_id, i.invoice_number, r.receipt_number, r.account_code,
             a.name AS account_name, r.amount_minor, r.reference, r.note, r.created_at,
             r.receivable_minor, r.advance_minor, r.reversed_at, r.reversal_reason
      FROM customer_receipts r
      JOIN ledger_accounts a ON a.code = r.account_code
      LEFT JOIN invoices i ON i.id = r.invoice_id
      WHERE r.customer_id = ? ORDER BY r.created_at DESC, r.rowid DESC
    `).all(id) as ReceiptRow[];
    const receipts: CustomerReceipt[] = receiptRows.map((row) => ({
      id: row.id,
      receiptNumber: row.receipt_number,
      account: row.account_code === "1010" ? "bank" : "cash",
      paymentMethod: row.account_name,
      invoiceId: row.invoice_id ?? undefined,
      invoiceNumber: row.invoice_number ?? undefined,
      amountMinor: row.amount_minor,
      receivableMinor: row.receivable_minor,
      advanceMinor: row.advance_minor,
      reference: row.reference,
      note: row.note,
      createdAt: row.created_at,
      reversedAt: row.reversed_at ?? undefined,
      reversalReason: row.reversal_reason || undefined,
    }));
    return { customer, sales, receipts, statement: null };
  }

  paymentAccounts(): PaymentAccount[] {
    return this.database.prepare(`
      SELECT code, name FROM ledger_accounts
      WHERE account_type = 'asset' AND is_payment_account = 1
      ORDER BY code
    `).all() as PaymentAccount[];
  }

  receive(input: CustomerReceiptInput): CustomerDetails {
    const id = randomUUID();
    const receiptNumber = `CR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${id.slice(0, 6).toUpperCase()}`;
    const amount = Math.round(input.amount * 100);
    const now = new Date().toISOString();
    const accountCode = input.accountCode ?? (input.account === "bank" ? "1010" : "1000");
    const transaction = this.database.transaction(() => {
      this.requireCustomer(input.customerId);
      this.requirePaymentAccount(accountCode);
      let receivableMinor = amount;
      let advanceMinor = 0;
      if (input.invoiceId) {
        const invoice = this.database.prepare(`
          SELECT total_minor, amount_received_minor, returned_minor FROM invoices
          WHERE id = ? AND customer_id = ?
        `).get(input.invoiceId, input.customerId) as {
          total_minor: number;
          amount_received_minor: number;
          returned_minor: number;
        } | undefined;
        if (!invoice) throw new FabricServiceError("NOT_FOUND", "Customer invoice not found.");
        if (amount > invoice.total_minor - invoice.amount_received_minor - invoice.returned_minor) {
          throw new FabricServiceError("VALIDATION", "Receipt exceeds the remaining amount due on this invoice.");
        }
        this.database.prepare("UPDATE invoices SET amount_received_minor = amount_received_minor + ? WHERE id = ?")
          .run(amount, input.invoiceId);
      } else {
        const outstanding = this.database.prepare(`
          SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS balance
          FROM ledger_postings WHERE account_code = '1300' AND customer_id = ?
        `).get(input.customerId) as { balance: number };
        receivableMinor = Math.min(amount, Math.max(0, outstanding.balance));
        advanceMinor = amount - receivableMinor;
      }
      this.database.prepare(`
        INSERT INTO customer_receipts (
          id, customer_id, invoice_id, receipt_number, account_code, amount_minor,
          receivable_minor, advance_minor, reference, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.customerId, input.invoiceId ?? null, receiptNumber, accountCode, amount,
        receivableMinor, advanceMinor, input.reference, input.note, now,
      );
      postJournal(this.database, "customer_receipt", receiptNumber, now, [
        { accountCode, debitMinor: amount },
        ...(receivableMinor > 0
          ? [{ accountCode: "1300", customerId: input.customerId, creditMinor: receivableMinor }]
          : []),
        ...(advanceMinor > 0
          ? [{ accountCode: "2200", customerId: input.customerId, creditMinor: advanceMinor }]
          : []),
      ], "System", id);
      writeAuditLog(
        this.database, "Operator", "customer_receipt", "customer_receipt", id,
        input.note || input.reference || "Customer payment received", now,
      );
    });
    transaction.immediate();
    return this.get(input.customerId);
  }

  reverseReceipt(input: CustomerReceiptReversalInput, authorizedUser = "Staff"): CustomerDetails {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const receipt = this.database.prepare(`
        SELECT id, customer_id, invoice_id, receipt_number, account_code, amount_minor,
               receivable_minor, advance_minor, reversed_at
        FROM customer_receipts WHERE id = ?
      `).get(input.receiptId) as {
        id: string;
        customer_id: string;
        invoice_id: string | null;
        receipt_number: string;
        account_code: string;
        amount_minor: number;
        receivable_minor: number;
        advance_minor: number;
        reversed_at: string | null;
      } | undefined;
      if (!receipt) throw new FabricServiceError("NOT_FOUND", "Customer receipt not found.");
      if (receipt.reversed_at) throw new FabricServiceError("CONFLICT", "This customer receipt has already been reversed.");
      if (receipt.invoice_id) {
        const result = this.database.prepare(`
          UPDATE invoices SET amount_received_minor = amount_received_minor - ?
          WHERE id = ? AND amount_received_minor >= ?
        `).run(receipt.amount_minor, receipt.invoice_id, receipt.amount_minor);
        if (result.changes === 0) throw new FabricServiceError("CONFLICT", "The receipt can no longer be reversed against this invoice.");
      }
      this.database.prepare(`
        UPDATE customer_receipts SET reversed_at = ?, reversal_reason = ? WHERE id = ?
      `).run(now, input.reason, receipt.id);
      postJournal(this.database, "customer_receipt_reversal", receipt.receipt_number, now, receipt.invoice_id
        ? [
          { accountCode: "1300", customerId: receipt.customer_id, debitMinor: receipt.amount_minor },
          { accountCode: receipt.account_code, creditMinor: receipt.amount_minor },
        ]
        : [
          ...(receipt.receivable_minor > 0
            ? [{ accountCode: "1300", customerId: receipt.customer_id, debitMinor: receipt.receivable_minor }]
            : []),
          ...(receipt.advance_minor > 0
            ? [{ accountCode: "2200", customerId: receipt.customer_id, debitMinor: receipt.advance_minor }]
            : []),
          { accountCode: receipt.account_code, creditMinor: receipt.amount_minor },
        ], "System", `receipt-reversal:${receipt.id}`);
      writeAuditLog(
        this.database, authorizedUser, "customer_receipt_reversal", "customer_receipt",
        receipt.id, input.reason, now,
      );
    });
    transaction.immediate();
    const receiptCustomer = this.database.prepare("SELECT customer_id FROM customer_receipts WHERE id = ?")
      .get(input.receiptId) as { customer_id: string };
    return this.get(receiptCustomer.customer_id);
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
        COALESCE((
          SELECT SUM(p.credit_minor - p.debit_minor)
          FROM ledger_postings p WHERE p.account_code = '2200' AND p.customer_id = c.id
        ), 0) AS advance_minor,
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

  private requirePaymentAccount(code: string): void {
    const row = this.database.prepare(`
      SELECT code FROM ledger_accounts
      WHERE code = ? AND account_type = 'asset' AND is_payment_account = 1
    `).get(code);
    if (!row) throw new FabricServiceError("VALIDATION", "Choose a configured cash or payment account.");
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE";
  }
}
