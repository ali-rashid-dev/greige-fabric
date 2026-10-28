import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CreateInvoiceInput,
  FabricInput,
  StockAdjustmentInput,
  UpdateFabricInput,
} from "../../shared/contracts";
import type {
  Fabric,
  FabricDetails,
  FabricFilters,
  Invoice,
  InvoiceItem,
  StockSummary,
} from "../../shared/types";
import { InventoryService } from "./inventory";
import { calculateMinorValue, postJournal } from "./accounting";
import { FabricServiceError } from "./errors";
import { writeAuditLog } from "./audit";

export { FabricServiceError } from "./errors";

interface FabricRow {
  id: string;
  sku: string;
  name: string;
  construction: string;
  composition: string;
  width_inches: number;
  gsm: number;
  purchase_cost_minor: number;
  selling_rate_minor: number;
  reorder_threshold_mm: number;
  stock_qty_mm: number;
  active: number;
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

function mapFabric(row: FabricRow): Fabric {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    construction: row.construction,
    composition: row.composition,
    widthInches: row.width_inches,
    gsm: row.gsm,
    purchaseCostMinor: row.purchase_cost_minor,
    sellingRateMinor: row.selling_rate_minor,
    reorderThresholdMm: row.reorder_threshold_mm,
    stockMm: row.stock_qty_mm,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInvoiceItem(row: InvoiceItemRow): InvoiceItem {
  return {
    id: row.id,
    fabricId: row.fabric_id,
    sku: row.sku_snapshot,
    name: row.name_snapshot,
    quantityMm: row.quantity_mm,
    unitPriceMinor: row.unit_price_minor,
    lineTotalMinor: row.line_total_minor,
  };
}

function mapInvoice(row: InvoiceRow, items: InvoiceItem[]): Invoice {
  const subtotalMinor = items.reduce((total, item) => total + item.lineTotalMinor, 0);
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
    items,
  };
}

function mapInput(input: FabricInput): Omit<Fabric, "id" | "stockMm" | "active" | "createdAt" | "updatedAt"> {
  return {
    sku: input.sku,
    name: input.name,
    construction: input.construction,
    composition: input.composition,
    widthInches: input.widthInches,
    gsm: input.gsm,
    purchaseCostMinor: Math.round(input.purchaseCost * 100),
    sellingRateMinor: Math.round(input.sellingRate * 100),
    reorderThresholdMm: Math.round(input.reorderThresholdMeters * 1000),
  };
}

export class FabricService {
  private readonly inventory: InventoryService;

  constructor(private readonly database: Database.Database) {
    this.inventory = new InventoryService(database);
  }

  private getFabric(id: string): Fabric {
    const row = this.database.prepare(`
      SELECT * FROM fabrics WHERE id = ?
    `).get(id) as FabricRow | undefined;
    if (!row) throw new FabricServiceError("NOT_FOUND", "Fabric product not found.");
    return mapFabric(row);
  }

  list(filters: FabricFilters): Fabric[] {
    const conditions: string[] = [];
    const values: Array<string> = [];

    if (filters.query) {
      const query = `%${filters.query}%`;
      conditions.push("(f.sku LIKE ? OR f.name LIKE ? OR f.construction LIKE ? OR f.composition LIKE ?)");
      values.push(query, query, query, query);
    }
    if (filters.status === "active") conditions.push("f.active = 1");
    if (filters.status === "inactive") conditions.push("f.active = 0");
    if (filters.status === "low-stock") {
      conditions.push("f.active = 1 AND f.stock_qty_mm <= f.reorder_threshold_mm");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT f.*
      FROM fabrics f
      ${where}
      ORDER BY f.sku COLLATE NOCASE
    `).all(...values) as FabricRow[];
    return rows.map(mapFabric);
  }

  get(id: string): FabricDetails {
    const fabric = this.getFabric(id);
    const invoices = this.database.prepare(`
      SELECT DISTINCT i.id, i.invoice_number, i.total_minor, i.discount_minor,
             i.amount_received_minor, i.payment_account_code, i.created_at,
             i.returned_minor,
             i.customer_id, c.code AS customer_code, c.name AS customer_name,
             i.customer_phone, i.customer_address, i.payment_terms_days
      FROM invoices i
      JOIN invoice_items item ON item.invoice_id = i.id
      LEFT JOIN customers c ON c.id = i.customer_id
      WHERE item.fabric_id = ?
      ORDER BY i.created_at DESC
    `).all(id) as InvoiceRow[];

    return {
      fabric,
      invoices: invoices.map((invoice) => {
        const items = this.database.prepare(`
          SELECT id, fabric_id, sku_snapshot, name_snapshot, quantity_mm, unit_price_minor, line_total_minor
          FROM invoice_items WHERE invoice_id = ? ORDER BY rowid
        `).all(invoice.id) as InvoiceItemRow[];
        return mapInvoice(invoice, items.map(mapInvoiceItem));
      }),
    };
  }

  create(input: FabricInput): Fabric {
    const fields = mapInput(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.database.prepare(`
        INSERT INTO fabrics (
          id, sku, name, construction, composition, width_inches, gsm,
          purchase_cost_minor, selling_rate_minor, reorder_threshold_mm,
          active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id, fields.sku, fields.name, fields.construction, fields.composition,
        fields.widthInches, fields.gsm, fields.purchaseCostMinor,
        fields.sellingRateMinor, fields.reorderThresholdMm, now, now,
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new FabricServiceError("CONFLICT", "That SKU is already in use.");
      }
      throw error;
    }
    return this.getFabric(id);
  }

  update(input: UpdateFabricInput): Fabric {
    const fields = mapInput(input);
    try {
      const result = this.database.prepare(`
        UPDATE fabrics SET
          sku = ?, name = ?, construction = ?, composition = ?, width_inches = ?, gsm = ?,
          purchase_cost_minor = ?, selling_rate_minor = ?, reorder_threshold_mm = ?, updated_at = ?
        WHERE id = ?
      `).run(
        fields.sku, fields.name, fields.construction, fields.composition,
        fields.widthInches, fields.gsm, fields.purchaseCostMinor,
        fields.sellingRateMinor, fields.reorderThresholdMm,
        new Date().toISOString(), input.id,
      );
      if (result.changes === 0) throw new FabricServiceError("NOT_FOUND", "Fabric product not found.");
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new FabricServiceError("CONFLICT", "That SKU is already in use.");
      }
      throw error;
    }
    return this.getFabric(input.id);
  }

  setActive(id: string, active: boolean): Fabric {
    const result = this.database.prepare(
      "UPDATE fabrics SET active = ?, updated_at = ? WHERE id = ?",
    ).run(active ? 1 : 0, new Date().toISOString(), id);
    if (result.changes === 0) throw new FabricServiceError("NOT_FOUND", "Fabric product not found.");
    return this.getFabric(id);
  }

  adjustStock(input: StockAdjustmentInput, authorizedUser: string): Fabric {
    this.inventory.adjustStock(input, authorizedUser);
    return this.getFabric(input.fabricId);
  }

  stockSummary(): StockSummary {
    const fabrics = this.list({ query: "", status: "all" });
    const activeFabrics = fabrics.filter((fabric) => fabric.active);
    return {
      totalProducts: fabrics.length,
      activeProducts: activeFabrics.length,
      lowStockCount: activeFabrics.filter((fabric) => fabric.stockMm <= fabric.reorderThresholdMm).length,
      totalStockMm: activeFabrics.reduce((total, fabric) => total + fabric.stockMm, 0),
      fabrics,
    };
  }

  createInvoice(input: CreateInvoiceInput): Invoice {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const datePart = createdAt.slice(0, 10).replaceAll("-", "");
    const invoiceNumber = `GF-${datePart}-${id.slice(0, 6).toUpperCase()}`;
    let totalMinor = 0;
    let invoiceCustomer: {
      id: string;
      code: string;
      name: string;
      phone: string;
      address: string;
      payment_terms_days: number;
      credit_limit_minor: number;
    } | undefined;
    const invoiceItems: InvoiceItem[] = [];

    const create = this.database.transaction(() => {
      if (input.customerId) {
        invoiceCustomer = this.database.prepare(`
          SELECT id, code, name, phone, address, payment_terms_days, credit_limit_minor
          FROM customers WHERE id = ? AND active = 1
        `).get(input.customerId) as {
          id: string;
          code: string;
          name: string;
          phone: string;
          address: string;
          payment_terms_days: number;
          credit_limit_minor: number;
        } | undefined;
        if (!invoiceCustomer) throw new FabricServiceError("NOT_FOUND", "Active customer not found.");
      }
      const lines = input.items.map((item) => {
        const fabric = this.getFabric(item.fabricId);
        if (!fabric.active) {
          throw new FabricServiceError("CONFLICT", `${fabric.sku} is inactive and cannot be sold.`);
        }
        const quantityMm = Math.round(item.quantityMeters * 1000);
        if (fabric.stockMm < quantityMm) {
          throw new FabricServiceError("INSUFFICIENT_STOCK", `Not enough stock for ${fabric.sku}.`);
        }
        const unitPriceMinor = item.unitRate === undefined
          ? fabric.sellingRateMinor
          : Math.round(item.unitRate * 100);
        return {
          fabric,
          quantityMm,
          costMinor: this.inventory.costForRemoval(fabric.id, quantityMm),
          unitPriceMinor,
          lineTotalMinor: calculateMinorValue(quantityMm, unitPriceMinor),
        };
      });

      const subtotalMinor = lines.reduce((total, line) => total + line.lineTotalMinor, 0);
      const discountMinor = Math.round((input.discount ?? 0) * 100);
      if (!Number.isSafeInteger(subtotalMinor)) {
        throw new FabricServiceError("VALIDATION", "The invoice total exceeds the supported accounting precision.");
      }
      if (discountMinor > subtotalMinor) {
        throw new FabricServiceError("VALIDATION", "The discount cannot exceed the invoice subtotal.");
      }
      totalMinor = subtotalMinor - discountMinor;
      const amountReceivedMinor = input.receivedAmount === undefined
        ? 0
        : Math.round(input.receivedAmount * 100);
      if (!Number.isSafeInteger(totalMinor) || amountReceivedMinor > totalMinor) {
        throw new FabricServiceError("VALIDATION", "The received amount cannot exceed the invoice total.");
      }
      const amountDueMinor = totalMinor - amountReceivedMinor;
      if (input.receivedAmount !== undefined && amountDueMinor > 0 && !invoiceCustomer) {
        throw new FabricServiceError("VALIDATION", "Select a customer for a sale with an outstanding balance.");
      }
      if (invoiceCustomer) {
        const outstanding = this.database.prepare(`
          SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS balance
          FROM ledger_postings WHERE account_code = '1300' AND customer_id = ?
        `).get(invoiceCustomer.id) as { balance: number };
        if (outstanding.balance + amountDueMinor > invoiceCustomer.credit_limit_minor) {
          throw new FabricServiceError("CONFLICT", "This sale would exceed the customer's credit limit.");
        }
      }
      const costOfGoodsSold = lines.reduce((total, line) => total + line.costMinor, 0);
      const paymentAccountCode = input.paymentAccount === "bank" ? "1010" : "1000";
      this.database.prepare(`
        INSERT INTO invoices (
          id, invoice_number, total_minor, created_at, customer_id,
          discount_minor, amount_received_minor, payment_account_code,
          customer_phone, customer_address, payment_terms_days
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, invoiceNumber, totalMinor, createdAt, invoiceCustomer?.id ?? null,
        discountMinor, amountReceivedMinor, paymentAccountCode,
        invoiceCustomer?.phone ?? null, invoiceCustomer?.address ?? null,
        invoiceCustomer?.payment_terms_days ?? null,
      );
      for (const line of lines) {
        const itemId = randomUUID();
        this.database.prepare(`
          INSERT INTO invoice_items (
            id, invoice_id, fabric_id, sku_snapshot, name_snapshot, quantity_mm,
            unit_price_minor, line_total_minor, cost_of_goods_sold_minor
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          itemId, id, line.fabric.id, line.fabric.sku, line.fabric.name,
          line.quantityMm, line.unitPriceMinor, line.lineTotalMinor, line.costMinor,
        );
        invoiceItems.push({
          id: itemId,
          fabricId: line.fabric.id,
          sku: line.fabric.sku,
          name: line.fabric.name,
          quantityMm: line.quantityMm,
          unitPriceMinor: line.unitPriceMinor,
          lineTotalMinor: line.lineTotalMinor,
        });
        this.inventory.postMovement({
          fabricId: line.fabric.id,
          quantityMm: -line.quantityMm,
          type: "sale",
          reference: invoiceNumber,
          reason: `Invoice ${invoiceNumber}`,
          authorizedUser: "POS",
          createdAt,
        });
      }
      postJournal(this.database, "sale", invoiceNumber, createdAt, [
        ...(amountReceivedMinor > 0
          ? [{ accountCode: paymentAccountCode, debitMinor: amountReceivedMinor }]
          : []),
        ...(amountDueMinor > 0
          ? [{ accountCode: "1300", debitMinor: amountDueMinor, customerId: invoiceCustomer?.id }]
          : []),
        { accountCode: "4000", creditMinor: totalMinor },
        { accountCode: "5000", debitMinor: costOfGoodsSold },
        { accountCode: "1200", creditMinor: costOfGoodsSold },
      ], "System", id);
      writeAuditLog(this.database, "POS", "sale", "invoice", id, `Invoice ${invoiceNumber}`, createdAt);
    });
    create.immediate();
    return {
      id,
      invoiceNumber,
      subtotalMinor: invoiceItems.reduce((total, item) => total + item.lineTotalMinor, 0),
      discountMinor: Math.round((input.discount ?? 0) * 100),
      totalMinor,
      amountReceivedMinor: input.receivedAmount === undefined ? 0 : Math.round(input.receivedAmount * 100),
      dueMinor: totalMinor - (input.receivedAmount === undefined ? 0 : Math.round(input.receivedAmount * 100)),
      paymentAccount: input.paymentAccount ?? "cash",
      createdAt,
      ...(invoiceCustomer ? {
        customerId: invoiceCustomer.id,
        customerCode: invoiceCustomer.code,
        customerName: invoiceCustomer.name,
        customerPhone: invoiceCustomer.phone,
        customerAddress: invoiceCustomer.address,
        paymentTermsDays: invoiceCustomer.payment_terms_days,
      } : {}),
      items: invoiceItems,
    };
  }

  listInvoices(): Invoice[] {
    const rows = this.database.prepare(`
      SELECT i.id, i.invoice_number, i.total_minor, i.discount_minor,
             i.amount_received_minor, i.payment_account_code, i.created_at,
             i.returned_minor,
             i.customer_id, c.code AS customer_code, c.name AS customer_name,
             i.customer_phone, i.customer_address, i.payment_terms_days
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      ORDER BY i.created_at DESC
    `).all() as InvoiceRow[];
    return rows.map((row) => {
      const items = this.database.prepare(`
        SELECT id, fabric_id, sku_snapshot, name_snapshot, quantity_mm, unit_price_minor, line_total_minor
        FROM invoice_items WHERE invoice_id = ? ORDER BY rowid
      `).all(row.id) as InvoiceItemRow[];
      return mapInvoice(row, items.map(mapInvoiceItem));
    });
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE";
  }
}
