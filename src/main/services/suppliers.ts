import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  SupplierAdjustmentInput,
  SupplierInput,
  SupplierListInput,
  SupplierPaymentInput,
  SupplierPaymentReversalInput,
  SupplierPurchaseInput,
  SupplierStatementInput,
  UpdateSupplierInput,
} from "../../shared/contracts";
import type {
  Supplier,
  SupplierDetails,
  SupplierPayment,
  SupplierPurchase,
  SupplierStatement,
} from "../../shared/types";
import { FabricServiceError } from "./errors";
import { InventoryService } from "./inventory";
import { allocateMinorValue, calculateMinorValue, postJournal } from "./accounting";
import { writeAuditLog } from "./audit";

interface SupplierRow {
  id: string;
  code: string;
  name: string;
  phone: string;
  address: string;
  contact_name: string;
  email: string;
  active: number;
  outstanding_minor: number;
  purchase_count: number;
  payment_count: number;
  created_at: string;
  updated_at: string;
}

interface PurchaseRow {
  id: string;
  bill_number: string;
  reference: string;
  purchase_date: string;
  total_minor: number;
  additional_cost_minor: number;
  additional_cost_description: string;
  payment_mode: "credit" | "cash" | "bank";
  paid_minor: number;
  created_at: string;
}

interface PurchaseItemRow {
  id: string;
  fabric_id: string;
  sku: string;
  name: string;
  quantity_mm: number;
  unit_cost_minor: number;
  allocated_cost_minor: number;
  line_total_minor: number;
}

interface PaymentRow {
  id: string;
  purchase_id: string | null;
  payment_number: string;
  account_code: string;
  account_name: string;
  amount_minor: number;
  reference: string;
  note: string;
  created_at: string;
  reversed_at: string | null;
  reversal_reason: string;
}

function toSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    address: row.address,
    contactName: row.contact_name,
    email: row.email,
    active: row.active === 1,
    outstandingMinor: row.outstanding_minor,
    purchaseCount: row.purchase_count,
    paymentCount: row.payment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupplierService {
  private readonly inventory: InventoryService;

  constructor(private readonly database: Database.Database) {
    this.inventory = new InventoryService(database);
  }

  list(input: SupplierListInput): Supplier[] {
    const query = `%${input.query}%`;
    const rows = this.database.prepare(`
      SELECT s.*,
        COALESCE((
          SELECT SUM(p.credit_minor - p.debit_minor)
          FROM ledger_postings p WHERE p.account_code = '2100' AND p.supplier_id = s.id
        ), 0) AS outstanding_minor,
        (SELECT COUNT(*) FROM supplier_purchases pu WHERE pu.supplier_id = s.id) AS purchase_count,
        (SELECT COUNT(*) FROM supplier_payments pa WHERE pa.supplier_id = s.id) AS payment_count
      FROM suppliers s
      WHERE (? = '%%' OR s.code LIKE ? OR s.name LIKE ? OR s.phone LIKE ?)
        AND (? = 1 OR s.active = 1)
      ORDER BY s.name COLLATE NOCASE
    `).all(query, query, query, query, input.includeInactive ? 1 : 0) as SupplierRow[];
    return rows.map(toSupplier);
  }

  get(id: string): SupplierDetails {
    const supplier = this.getSupplier(id);
    const purchaseRows = this.database.prepare(`
      SELECT id, bill_number, reference, purchase_date, total_minor,
             additional_cost_minor, additional_cost_description,
             payment_mode, paid_minor, created_at
      FROM supplier_purchases WHERE supplier_id = ? ORDER BY created_at DESC
    `).all(id) as PurchaseRow[];
    const purchases: SupplierPurchase[] = purchaseRows.map((purchase) => {
      const items = this.database.prepare(`
        SELECT pi.id, pi.fabric_id, f.sku, f.name, pi.quantity_mm,
               pi.unit_cost_minor, pi.allocated_cost_minor, pi.line_total_minor
        FROM supplier_purchase_items pi JOIN fabrics f ON f.id = pi.fabric_id
        WHERE pi.purchase_id = ? ORDER BY pi.rowid
      `).all(purchase.id) as PurchaseItemRow[];
      return {
        id: purchase.id,
        billNumber: purchase.bill_number,
        reference: purchase.reference,
        purchaseDate: purchase.purchase_date,
        totalMinor: purchase.total_minor,
        additionalCostsMinor: purchase.additional_cost_minor,
        additionalCostsDescription: purchase.additional_cost_description,
        paymentMode: purchase.payment_mode,
        paidMinor: purchase.paid_minor,
        dueMinor: purchase.total_minor - purchase.paid_minor,
        createdAt: purchase.created_at,
        items: items.map((item) => ({
          id: item.id,
          fabricId: item.fabric_id,
          sku: item.sku,
          fabricName: item.name,
          quantityMm: item.quantity_mm,
          unitCostMinor: item.unit_cost_minor,
          allocatedCostMinor: item.allocated_cost_minor,
          lineTotalMinor: item.line_total_minor,
        })),
      };
    });
    const paymentRows = this.database.prepare(`
      SELECT p.id, p.purchase_id, p.payment_number, p.account_code, a.name AS account_name,
             p.amount_minor, p.reference, p.note, p.created_at, p.reversed_at, p.reversal_reason
      FROM supplier_payments p
      JOIN ledger_accounts a ON a.code = p.account_code
      WHERE p.supplier_id = ? ORDER BY p.created_at DESC, p.rowid DESC
    `).all(id) as PaymentRow[];
    return {
      supplier,
      purchases,
      payments: paymentRows.map((payment): SupplierPayment => ({
        id: payment.id,
        purchaseId: payment.purchase_id ?? undefined,
        paymentNumber: payment.payment_number,
        account: payment.account_code === "1010" ? "bank" : "cash",
        paymentMethod: payment.account_name,
        amountMinor: payment.amount_minor,
        reference: payment.reference,
        note: payment.note,
        createdAt: payment.created_at,
        reversedAt: payment.reversed_at ?? undefined,
        reversalReason: payment.reversal_reason || undefined,
      })),
    };
  }

  create(input: SupplierInput, authorizedUser: string): Supplier {
    const id = randomUUID();
    const now = new Date().toISOString();
    const openingBalance = Math.round(input.openingBalance * 100);
    if (openingBalance > 0 && !authorizedUser.trim()) {
      throw new FabricServiceError("AUTHORIZATION", "An authorized user is required for supplier opening balances.");
    }
    const transaction = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO suppliers (id, code, name, phone, address, contact_name, email, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.code, input.name, input.phone, input.address, input.contactName, input.email, now, now);
      if (openingBalance > 0) {
        postJournal(this.database, "supplier_opening_balance", `Opening balance ${input.code}`, now, [
          { accountCode: "3000", debitMinor: openingBalance },
          { accountCode: "2100", creditMinor: openingBalance, supplierId: id },
        ], authorizedUser, id);
      }
    });
    try {
      transaction.immediate();
    } catch (error) {
      if (this.isUniqueViolation(error)) throw new FabricServiceError("CONFLICT", "That supplier code is already in use.");
      throw error;
    }
    return this.getSupplier(id);
  }

  update(input: UpdateSupplierInput): Supplier {
    const result = this.database.prepare(`
      UPDATE suppliers SET code = ?, name = ?, phone = ?, address = ?,
        contact_name = ?, email = ?, updated_at = ? WHERE id = ?
    `).run(
      input.code, input.name, input.phone, input.address,
      input.contactName, input.email, new Date().toISOString(), input.id,
    );
    if (result.changes === 0) throw new FabricServiceError("NOT_FOUND", "Supplier not found.");
    return this.getSupplier(input.id);
  }

  receive(input: SupplierPurchaseInput): SupplierDetails {
    const id = randomUUID();
    const now = new Date().toISOString();
    const purchaseTimestamp = `${input.purchaseDate}T00:00:00.000Z`;
    const lines = input.items.map((item) => ({
      fabricId: item.fabricId,
      quantityMm: Math.round(item.quantityMeters * 1000),
      unitCostMinor: Math.round(item.unitCost * 100),
    }));
    const materialLineTotals = lines.map((line) => calculateMinorValue(line.quantityMm, line.unitCostMinor));
    const materialTotal = materialLineTotals.reduce((sum, lineTotal) => sum + lineTotal, 0);
    const additionalCostMinor = Math.round(input.additionalCosts * 100);
    if (!Number.isSafeInteger(materialTotal + additionalCostMinor)) {
      throw new FabricServiceError("VALIDATION", "The purchase total exceeds the supported accounting precision.");
    }
    const allocationWeights = materialTotal > 0
      ? materialLineTotals
      : lines.map((line) => line.quantityMm);
    const allocatedCosts = allocateMinorValue(additionalCostMinor, allocationWeights);
    const lineTotals = materialLineTotals.map((lineTotal, index) => lineTotal + allocatedCosts[index]);
    const total = lineTotals.reduce((sum, lineTotal) => sum + lineTotal, 0);
    const paidMinor = Math.round(input.amountPaid * 100);
    if (paidMinor > total) {
      throw new FabricServiceError("VALIDATION", "The payment cannot exceed the supplier invoice total.");
    }
    if (input.paymentMode !== "credit" && paidMinor !== total) {
      throw new FabricServiceError("VALIDATION", "Cash and bank purchases must be paid in full when received.");
    }
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(paidMinor)) {
      throw new FabricServiceError("VALIDATION", "The purchase total exceeds the supported accounting precision.");
    }
    const transaction = this.database.transaction(() => {
      this.requireSupplier(input.supplierId);
      this.database.prepare(`
        INSERT INTO supplier_purchases (
          id, supplier_id, bill_number, reference, total_minor, created_at,
          purchase_date, additional_cost_minor, additional_cost_description,
          payment_mode, paid_minor
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.supplierId, input.billNumber, input.reference, total, now,
        input.purchaseDate, additionalCostMinor, input.additionalCostsDescription,
        input.paymentMode, paidMinor,
      );
      const insertItem = this.database.prepare(`
        INSERT INTO supplier_purchase_items (
          id, purchase_id, fabric_id, quantity_mm, unit_cost_minor,
          allocated_cost_minor, line_total_minor
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [index, line] of lines.entries()) {
        const fabric = this.database.prepare(
          "SELECT active FROM fabrics WHERE id = ?",
        ).get(line.fabricId) as { active: number } | undefined;
        if (!fabric) throw new FabricServiceError("NOT_FOUND", "Fabric product not found.");
        if (fabric.active !== 1) throw new FabricServiceError("CONFLICT", "Inactive fabrics cannot be received.");
        const lineTotal = lineTotals[index];
        insertItem.run(
          randomUUID(), id, line.fabricId, line.quantityMm, line.unitCostMinor,
          allocatedCosts[index], lineTotal,
        );
        this.inventory.postMovement({
          fabricId: line.fabricId,
          quantityMm: line.quantityMm,
          type: "purchase",
          reference: input.billNumber,
          reason: `Supplier receipt ${input.billNumber}`,
          authorizedUser: "Supplier receipt",
          createdAt: now,
          incomingValueMinor: lineTotal,
        });
      }
      const purchaseAccountLines = input.paymentMode === "credit"
        ? [
          { accountCode: "1200", debitMinor: total },
          { accountCode: "2100", creditMinor: total, supplierId: input.supplierId },
        ]
        : [
          { accountCode: "1200", debitMinor: total },
          { accountCode: input.paymentMode === "cash" ? "1000" : "1010", creditMinor: total },
        ];
      postJournal(
        this.database,
        "supplier_purchase",
        input.billNumber,
        purchaseTimestamp,
        purchaseAccountLines,
        "Supplier receipt",
        id,
      );
      if (paidMinor > 0) {
        const paymentId = randomUUID();
        const paymentNumber = `PAY-${input.purchaseDate.replaceAll("-", "")}-${paymentId.slice(0, 6).toUpperCase()}`;
        const paymentAccountCode = input.paymentMode === "cash"
          ? "1000"
          : input.paymentMode === "bank"
            ? "1010"
            : input.paymentAccount === "bank" ? "1010" : "1000";
        if (input.paymentMode === "credit") {
          postJournal(this.database, "supplier_payment", paymentNumber, purchaseTimestamp, [
            { accountCode: "2100", supplierId: input.supplierId, debitMinor: paidMinor },
            { accountCode: paymentAccountCode, creditMinor: paidMinor },
          ], "Supplier receipt", paymentId);
        }
        this.database.prepare(`
          INSERT INTO supplier_payments (
            id, supplier_id, purchase_id, payment_number, account_code,
            amount_minor, reference, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          paymentId, input.supplierId, id, paymentNumber, paymentAccountCode,
          paidMinor, input.reference || input.billNumber,
          "Payment recorded at receipt", purchaseTimestamp,
        );
      }
      writeAuditLog(
        this.database, "Operator", "supplier_purchase", "supplier_purchase",
        id, `Supplier receipt ${input.billNumber}`, now,
      );
    });
    try {
      transaction.immediate();
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new FabricServiceError("CONFLICT", "That bill number is already recorded for this supplier.");
      }
      throw error;
    }
    return this.get(input.supplierId);
  }

  pay(input: SupplierPaymentInput): SupplierDetails {
    const id = randomUUID();
    const paymentNumber = `PAY-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${id.slice(0, 6).toUpperCase()}`;
    const amount = Math.round(input.amount * 100);
    const accountCode = input.accountCode ?? (input.account === "bank" ? "1010" : "1000");
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.requireSupplier(input.supplierId);
      this.requirePaymentAccount(accountCode);
      const outstanding = this.database.prepare(`
        SELECT COALESCE(SUM(credit_minor - debit_minor), 0) AS balance
        FROM ledger_postings WHERE account_code = '2100' AND supplier_id = ?
      `).get(input.supplierId) as { balance: number };
      if (amount > outstanding.balance) {
        throw new FabricServiceError("VALIDATION", "Payment cannot exceed the supplier's outstanding payable balance.");
      }
      if (input.purchaseId) {
        const purchase = this.database.prepare(`
          SELECT total_minor, paid_minor FROM supplier_purchases
          WHERE id = ? AND supplier_id = ?
        `).get(input.purchaseId, input.supplierId) as { total_minor: number; paid_minor: number } | undefined;
        if (!purchase) throw new FabricServiceError("NOT_FOUND", "Supplier purchase not found.");
        if (amount > purchase.total_minor - purchase.paid_minor) {
          throw new FabricServiceError("VALIDATION", "Payment exceeds the remaining amount due on this purchase.");
        }
        this.database.prepare("UPDATE supplier_purchases SET paid_minor = paid_minor + ? WHERE id = ?")
          .run(amount, input.purchaseId);
      }
      this.database.prepare(`
        INSERT INTO supplier_payments (
          id, supplier_id, purchase_id, payment_number, account_code, amount_minor, reference, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.supplierId, input.purchaseId ?? null, paymentNumber, accountCode,
        amount, input.reference, input.note, now,
      );
      postJournal(this.database, "supplier_payment", paymentNumber, now, [
        { accountCode: "2100", supplierId: input.supplierId, debitMinor: amount },
        { accountCode, creditMinor: amount },
      ], "System", id);
      writeAuditLog(
        this.database, "Operator", "supplier_payment", "supplier_payment",
        id, input.note || input.reference || "Supplier payment recorded", now,
      );
    });
    transaction.immediate();
    return this.get(input.supplierId);
  }

  reversePayment(input: SupplierPaymentReversalInput, authorizedUser = "Staff"): SupplierDetails {
    let supplierId = "";
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const payment = this.database.prepare(`
        SELECT id, supplier_id, purchase_id, payment_number, account_code, amount_minor, reversed_at
        FROM supplier_payments WHERE id = ?
      `).get(input.paymentId) as {
        id: string;
        supplier_id: string;
        purchase_id: string | null;
        payment_number: string;
        account_code: string;
        amount_minor: number;
        reversed_at: string | null;
      } | undefined;
      if (!payment) throw new FabricServiceError("NOT_FOUND", "Supplier payment not found.");
      if (payment.reversed_at) throw new FabricServiceError("CONFLICT", "This supplier payment has already been reversed.");
      supplierId = payment.supplier_id;
      if (payment.purchase_id) {
        const result = this.database.prepare(`
          UPDATE supplier_purchases SET paid_minor = paid_minor - ?
          WHERE id = ? AND paid_minor >= ?
        `).run(payment.amount_minor, payment.purchase_id, payment.amount_minor);
        if (result.changes === 0) throw new FabricServiceError("CONFLICT", "The payment can no longer be reversed against this purchase.");
      }
      this.database.prepare(`
        UPDATE supplier_payments SET reversed_at = ?, reversal_reason = ? WHERE id = ?
      `).run(now, input.reason, payment.id);
      postJournal(this.database, "supplier_payment_reversal", payment.payment_number, now, [
        { accountCode: payment.account_code, debitMinor: payment.amount_minor },
        { accountCode: "2100", supplierId: payment.supplier_id, creditMinor: payment.amount_minor },
      ], "System", `payment-reversal:${payment.id}`);
      writeAuditLog(
        this.database, authorizedUser, "supplier_payment_reversal", "supplier_payment",
        payment.id, input.reason, now,
      );
    });
    transaction.immediate();
    return this.get(supplierId);
  }

  adjust(input: SupplierAdjustmentInput, authorizedUser: string): SupplierDetails {
    if (!authorizedUser.trim()) {
      throw new FabricServiceError("AUTHORIZATION", "An authorized user is required for supplier adjustments.");
    }
    const amount = Math.round(input.amount * 100);
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.requireSupplier(input.supplierId);
      postJournal(this.database, "supplier_adjustment", input.reason, now, input.direction === "increase"
        ? [
          { accountCode: "5100", debitMinor: amount },
          { accountCode: "2100", creditMinor: amount, supplierId: input.supplierId },
        ]
        : [
          { accountCode: "2100", supplierId: input.supplierId, debitMinor: amount },
          { accountCode: "5100", creditMinor: amount },
        ], authorizedUser, randomUUID());
      writeAuditLog(
        this.database, authorizedUser, "supplier_adjustment", "supplier",
        input.supplierId, input.reason, now,
      );
    });
    transaction.immediate();
    return this.get(input.supplierId);
  }

  statement(input: SupplierStatementInput): SupplierStatement {
    this.requireSupplier(input.supplierId);
    const start = `${input.from}T00:00:00.000Z`;
    const end = `${input.to}T23:59:59.999Z`;
    const balanceBefore = this.database.prepare(`
      SELECT COALESCE(SUM(p.credit_minor - p.debit_minor), 0) AS balance
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = '2100' AND p.supplier_id = ? AND t.created_at < ?
    `).get(input.supplierId, start) as { balance: number };
    const rows = this.database.prepare(`
      SELECT t.transaction_type, t.reference, t.created_at, p.debit_minor, p.credit_minor
      FROM ledger_postings p JOIN ledger_transactions t ON t.id = p.transaction_id
      WHERE p.account_code = '2100' AND p.supplier_id = ?
        AND t.created_at >= ? AND t.created_at <= ?
      ORDER BY t.created_at, t.rowid, p.rowid
    `).all(input.supplierId, start, end) as Array<{
      transaction_type: string;
      reference: string;
      created_at: string;
      debit_minor: number;
      credit_minor: number;
    }>;
    let balance = balanceBefore.balance;
    const lines = rows.map((row) => {
      balance += row.credit_minor - row.debit_minor;
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
      supplierId: input.supplierId,
      from: input.from,
      to: input.to,
      openingBalanceMinor: balanceBefore.balance,
      closingBalanceMinor: balance,
      lines,
    };
  }

  reconcile(): { controlMinor: number; subledgerMinor: number; differenceMinor: number } {
    const control = this.database.prepare(`
      SELECT COALESCE(SUM(credit_minor - debit_minor), 0) AS balance
      FROM ledger_postings WHERE account_code = '2100'
    `).get() as { balance: number };
    const subledger = this.database.prepare(`
      SELECT COALESCE(SUM(credit_minor - debit_minor), 0) AS balance
      FROM ledger_postings WHERE account_code = '2100' AND supplier_id IS NOT NULL
    `).get() as { balance: number };
    return {
      controlMinor: control.balance,
      subledgerMinor: subledger.balance,
      differenceMinor: control.balance - subledger.balance,
    };
  }

  private getSupplier(id: string): Supplier {
    const row = this.database.prepare(`
      SELECT s.*,
        COALESCE((
          SELECT SUM(p.credit_minor - p.debit_minor)
          FROM ledger_postings p WHERE p.account_code = '2100' AND p.supplier_id = s.id
        ), 0) AS outstanding_minor,
        (SELECT COUNT(*) FROM supplier_purchases pu WHERE pu.supplier_id = s.id) AS purchase_count,
        (SELECT COUNT(*) FROM supplier_payments pa WHERE pa.supplier_id = s.id) AS payment_count
      FROM suppliers s WHERE s.id = ?
    `).get(id) as SupplierRow | undefined;
    if (!row) throw new FabricServiceError("NOT_FOUND", "Supplier not found.");
    return toSupplier(row);
  }

  private requireSupplier(id: string): void {
    const row = this.database.prepare("SELECT id FROM suppliers WHERE id = ?").get(id);
    if (!row) throw new FabricServiceError("NOT_FOUND", "Supplier not found.");
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
