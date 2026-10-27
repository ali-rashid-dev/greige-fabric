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

type ErrorCode = "NOT_FOUND" | "CONFLICT" | "INSUFFICIENT_STOCK";

export class FabricServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FabricServiceError";
  }
}

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
  stock_mm: number;
  active: number;
  created_at: string;
  updated_at: string;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  total_minor: number;
  created_at: string;
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
    stockMm: row.stock_mm,
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
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    totalMinor: row.total_minor,
    createdAt: row.created_at,
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
  constructor(private readonly database: Database.Database) {}

  private getFabric(id: string): Fabric {
    const row = this.database.prepare(`
      SELECT f.*,
        COALESCE((SELECT SUM(s.quantity_mm) FROM stock_movements s WHERE s.fabric_id = f.id), 0) AS stock_mm
      FROM fabrics f WHERE f.id = ?
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
      conditions.push(`f.active = 1 AND COALESCE(stock.stock_mm, 0) <= f.reorder_threshold_mm`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT f.*,
        COALESCE(stock.stock_mm, 0) AS stock_mm
      FROM fabrics f
      LEFT JOIN (
        SELECT fabric_id, SUM(quantity_mm) AS stock_mm
        FROM stock_movements GROUP BY fabric_id
      ) stock ON stock.fabric_id = f.id
      ${where}
      ORDER BY f.sku COLLATE NOCASE
    `).all(...values) as FabricRow[];
    return rows.map(mapFabric);
  }

  get(id: string): FabricDetails {
    const fabric = this.getFabric(id);
    const invoices = this.database.prepare(`
      SELECT DISTINCT i.id, i.invoice_number, i.total_minor, i.created_at
      FROM invoices i
      JOIN invoice_items item ON item.invoice_id = i.id
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

  adjustStock(input: StockAdjustmentInput): Fabric {
    const delta = Math.round(input.quantityMeters * 1000) * (input.direction === "add" ? 1 : -1);
    const transaction = this.database.transaction(() => {
      this.getFabric(input.fabricId);
      const stock = this.database.prepare(
        "SELECT COALESCE(SUM(quantity_mm), 0) AS quantity FROM stock_movements WHERE fabric_id = ?",
      ).get(input.fabricId) as { quantity: number };
      if (stock.quantity + delta < 0) {
        throw new FabricServiceError("INSUFFICIENT_STOCK", "Stock cannot be adjusted below zero.");
      }
      this.database.prepare(`
        INSERT INTO stock_movements (id, fabric_id, quantity_mm, reason, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), input.fabricId, delta, input.reason, new Date().toISOString());
    });
    transaction.immediate();
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
    const invoiceItems: InvoiceItem[] = [];

    const create = this.database.transaction(() => {
      const lines = input.items.map((item) => {
        const fabric = this.getFabric(item.fabricId);
        if (!fabric.active) {
          throw new FabricServiceError("CONFLICT", `${fabric.sku} is inactive and cannot be sold.`);
        }
        const quantityMm = Math.round(item.quantityMeters * 1000);
        if (fabric.stockMm < quantityMm) {
          throw new FabricServiceError("INSUFFICIENT_STOCK", `Not enough stock for ${fabric.sku}.`);
        }
        return {
          fabric,
          quantityMm,
          lineTotalMinor: Math.round(fabric.sellingRateMinor * quantityMm / 1000),
        };
      });

      totalMinor = lines.reduce((total, line) => total + line.lineTotalMinor, 0);
      this.database.prepare(
        "INSERT INTO invoices (id, invoice_number, total_minor, created_at) VALUES (?, ?, ?, ?)",
      ).run(id, invoiceNumber, totalMinor, createdAt);
      for (const line of lines) {
        const itemId = randomUUID();
        this.database.prepare(`
          INSERT INTO invoice_items (
            id, invoice_id, fabric_id, sku_snapshot, name_snapshot, quantity_mm,
            unit_price_minor, line_total_minor
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          itemId, id, line.fabric.id, line.fabric.sku, line.fabric.name,
          line.quantityMm, line.fabric.sellingRateMinor, line.lineTotalMinor,
        );
        invoiceItems.push({
          id: itemId,
          fabricId: line.fabric.id,
          sku: line.fabric.sku,
          name: line.fabric.name,
          quantityMm: line.quantityMm,
          unitPriceMinor: line.fabric.sellingRateMinor,
          lineTotalMinor: line.lineTotalMinor,
        });
        this.database.prepare(`
          INSERT INTO stock_movements (id, fabric_id, quantity_mm, reason, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), line.fabric.id, -line.quantityMm, `Invoice ${invoiceNumber}`, createdAt);
      }
    });
    create.immediate();
    return {
      id,
      invoiceNumber,
      totalMinor,
      createdAt,
      items: invoiceItems,
    };
  }

  listInvoices(): Invoice[] {
    const rows = this.database.prepare(`
      SELECT id, invoice_number, total_minor, created_at
      FROM invoices ORDER BY created_at DESC
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
