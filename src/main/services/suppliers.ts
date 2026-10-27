import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  SupplierAdjustmentInput,
  SupplierInput,
  SupplierListInput,
  SupplierPaymentInput,
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
import { calculateMinorValue, postJournal } from "./accounting";

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
  total_minor: number;
  created_at: string;
}

interface PurchaseItemRow {
  id: string;
  fabric_id: string;
  sku: string;
  name: string;
  quantity_mm: number;
  unit_cost_minor: number;
  line_total_minor: number;
}

interface PaymentRow {
  id: string;
  payment_number: string;
  account_code: string;
  amount_minor: number;
  reference: string;
  note: string;
  created_at: string;
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
      SELECT id, bill_number, reference, total_minor, created_at
      FROM supplier_purchases WHERE supplier_id = ? ORDER BY created_at DESC
    `).all(id) as PurchaseRow[];
    const purchases: SupplierPurchase[] = purchaseRows.map((purchase) => {
      const items = this.database.prepare(`
        SELECT pi.id, pi.fabric_id, f.sku, f.name, pi.quantity_mm,
               pi.unit_cost_minor, pi.line_total_minor
        FROM supplier_purchase_items pi JOIN fabrics f ON f.id = pi.fabric_id
        WHERE pi.purchase_id = ? ORDER BY pi.rowid
      `).all(purchase.id) as PurchaseItemRow[];
      return {
        id: purchase.id,
        billNumber: purchase.bill_number,
        reference: purchase.reference,
        totalMinor: purchase.total_minor,
        createdAt: purchase.created_at,
        items: items.map((item) => ({
          id: item.id,
          fabricId: item.fabric_id,
          sku: item.sku,
          fabricName: item.name,
          quantityMm: item.quantity_mm,
          unitCostMinor: item.unit_cost_minor,
          lineTotalMinor: item.line_total_minor,
        })),
      };
    });
    const paymentRows = this.database.prepare(`
      SELECT id, payment_number, account_code, amount_minor, reference, note, created_at
      FROM supplier_payments WHERE supplier_id = ? ORDER BY created_at DESC
    `).all(id) as PaymentRow[];
    return {
      supplier,
      purchases,
      payments: paymentRows.map((payment): SupplierPayment => ({
        id: payment.id,
        paymentNumber: payment.payment_number,
        account: payment.account_code === "1010" ? "bank" : "cash",
        amountMinor: payment.amount_minor,
        reference: payment.reference,
        note: payment.note,
        createdAt: payment.created_at,
      })),
    };
  }

  create(input: Omit<SupplierInput, "ownerPin">, authorizedUser: string): Supplier {
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
        ], authorizedUser);
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
    const lines = input.items.map((item) => ({
      fabricId: item.fabricId,
      quantityMm: Math.round(item.quantityMeters * 1000),
      unitCostMinor: Math.round(item.unitCost * 100),
    }));
    const lineTotals = lines.map((line) => calculateMinorValue(line.quantityMm, line.unitCostMinor));
    const total = lineTotals.reduce((sum, lineTotal) => sum + lineTotal, 0);
    if (!Number.isSafeInteger(total)) {
      throw new FabricServiceError("VALIDATION", "The purchase total exceeds the supported accounting precision.");
    }
    const transaction = this.database.transaction(() => {
      this.requireSupplier(input.supplierId);
      this.database.prepare(`
        INSERT INTO supplier_purchases (id, supplier_id, bill_number, reference, total_minor, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, input.supplierId, input.billNumber, input.reference, total, now);
      const insertItem = this.database.prepare(`
        INSERT INTO supplier_purchase_items (
          id, purchase_id, fabric_id, quantity_mm, unit_cost_minor, line_total_minor
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const [index, line] of lines.entries()) {
        const fabric = this.database.prepare(
          "SELECT active FROM fabrics WHERE id = ?",
        ).get(line.fabricId) as { active: number } | undefined;
        if (!fabric) throw new FabricServiceError("NOT_FOUND", "Fabric product not found.");
        if (fabric.active !== 1) throw new FabricServiceError("CONFLICT", "Inactive fabrics cannot be received.");
        const lineTotal = lineTotals[index];
        insertItem.run(randomUUID(), id, line.fabricId, line.quantityMm, line.unitCostMinor, lineTotal);
        this.inventory.postMovement({
          fabricId: line.fabricId,
          quantityMm: line.quantityMm,
          type: "purchase",
          reference: input.billNumber,
          reason: `Supplier receipt ${input.billNumber}`,
          authorizedUser: "Supplier receipt",
          createdAt: now,
          incomingUnitCostMinor: line.unitCostMinor,
        });
      }
      postJournal(this.database, "supplier_purchase", input.billNumber, now, [
        { accountCode: "1200", debitMinor: total },
        { accountCode: "2100", creditMinor: total, supplierId: input.supplierId },
      ]);
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
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.requireSupplier(input.supplierId);
      this.database.prepare(`
        INSERT INTO supplier_payments (
          id, supplier_id, payment_number, account_code, amount_minor, reference, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.supplierId, paymentNumber, input.account === "bank" ? "1010" : "1000",
        amount, input.reference, input.note, now,
      );
      postJournal(this.database, "supplier_payment", paymentNumber, now, [
        { accountCode: "2100", supplierId: input.supplierId, debitMinor: amount },
        { accountCode: input.account === "bank" ? "1010" : "1000", creditMinor: amount },
      ]);
    });
    transaction.immediate();
    return this.get(input.supplierId);
  }

  adjust(input: Omit<SupplierAdjustmentInput, "ownerPin">, authorizedUser: string): SupplierDetails {
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
        ], authorizedUser);
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

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE";
  }
}
