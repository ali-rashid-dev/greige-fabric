import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  OpeningStockInput,
  StockAdjustmentInput,
} from "../../shared/contracts";
import type { InventoryMovement, InventoryReport } from "../../shared/types";
import { calculateMinorValue, calculateProportionalValue, postJournal } from "./accounting";
import { FabricServiceError } from "./errors";

interface StockRow {
  stock_qty_mm: number;
  purchase_cost_minor: number;
  stock_value_minor: number;
}

interface MovementRow {
  id: string;
  fabric_id: string;
  sku: string;
  name: string;
  quantity_mm: number;
  movement_type: InventoryMovement["movementType"];
  reference: string;
  reason: string;
  authorized_user: string;
  created_at: string;
}

interface ValuationRow {
  id: string;
  sku: string;
  name: string;
  stock_qty_mm: number;
  purchase_cost_minor: number;
  stock_value_minor: number;
  reorder_threshold_mm: number;
  active: number;
}

export class InventoryService {
  constructor(private readonly database: Database.Database) {}

  openStock(input: Omit<OpeningStockInput, "ownerPin">, authorizedUser: string): void {
    const quantityMm = Math.round(input.quantityMeters * 1000);
    const unitCostMinor = Math.round(input.unitCost * 100);
    const createdAt = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.postMovement({
        fabricId: input.fabricId,
        quantityMm,
        type: "opening",
        reference: input.reference,
        reason: input.reason,
        authorizedUser,
        createdAt,
        incomingUnitCostMinor: unitCostMinor,
      });
      const value = calculateMinorValue(quantityMm, unitCostMinor);
      postJournal(this.database, "inventory_opening", input.reference, createdAt, [
        { accountCode: "1200", debitMinor: value },
        { accountCode: "3000", creditMinor: value },
      ]);
    });
    transaction.immediate();
  }

  adjustStock(input: Omit<StockAdjustmentInput, "ownerPin">, authorizedUser: string): void {
    if (!authorizedUser.trim()) {
      throw new FabricServiceError("AUTHORIZATION", "An authorized user is required for stock adjustments.");
    }
    const quantityMm = Math.round(input.quantityMeters * 1000);
    const delta = quantityMm * (input.direction === "add" ? 1 : -1);
    const createdAt = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const current = this.getStock(input.fabricId);
      if (current.stock_qty_mm + delta < 0) {
        throw new FabricServiceError("INSUFFICIENT_STOCK", "Stock cannot be adjusted below zero.");
      }
      const value = delta > 0
        ? calculateMinorValue(quantityMm, current.purchase_cost_minor)
        : calculateProportionalValue(current.stock_value_minor, quantityMm, current.stock_qty_mm);
      this.postMovement({
        fabricId: input.fabricId,
        quantityMm: delta,
        type: "adjustment",
        reference: input.reason,
        reason: input.reason,
        authorizedUser,
        createdAt,
      });
      postJournal(this.database, "inventory_adjustment", input.reason, createdAt, input.direction === "add"
        ? [
          { accountCode: "1200", debitMinor: value },
          { accountCode: "5100", creditMinor: value },
        ]
        : [
          { accountCode: "5100", debitMinor: value },
          { accountCode: "1200", creditMinor: value },
        ]);
    });
    transaction.immediate();
  }

  postMovement(input: {
    fabricId: string;
    quantityMm: number;
    type: InventoryMovement["movementType"];
    reference: string;
    reason: string;
    authorizedUser: string;
    createdAt: string;
    incomingUnitCostMinor?: number;
    incomingValueMinor?: number;
  }): void {
    const current = this.getStock(input.fabricId);
    const newQuantity = current.stock_qty_mm + input.quantityMm;
    if (newQuantity < 0) {
      throw new FabricServiceError("INSUFFICIENT_STOCK", "Stock cannot be reduced below zero.");
    }

    let updatedValue = current.stock_value_minor;
    if (input.incomingValueMinor !== undefined) {
      updatedValue += input.incomingValueMinor;
    } else if (input.incomingUnitCostMinor !== undefined) {
      updatedValue += calculateMinorValue(input.quantityMm, input.incomingUnitCostMinor);
    } else if (input.quantityMm > 0) {
      updatedValue += calculateMinorValue(input.quantityMm, current.purchase_cost_minor);
    } else {
      updatedValue -= calculateProportionalValue(
        current.stock_value_minor,
        -input.quantityMm,
        current.stock_qty_mm,
      );
    }
    if (newQuantity === 0) updatedValue = 0;
    if (!Number.isSafeInteger(updatedValue) || updatedValue < 0) {
      throw new FabricServiceError("VALIDATION", "The inventory value exceeds the supported accounting precision.");
    }
    const updatedCost = newQuantity === 0
      ? current.purchase_cost_minor
      : calculateProportionalValue(updatedValue, 1000, newQuantity);
    this.database.prepare(`
      UPDATE fabrics SET stock_qty_mm = ?, stock_value_minor = ?, purchase_cost_minor = ?, updated_at = ?
      WHERE id = ?
    `).run(newQuantity, updatedValue, updatedCost, input.createdAt, input.fabricId);
    this.database.prepare(`
      INSERT INTO stock_movements (
        id, fabric_id, quantity_mm, reason, created_at, movement_type, reference, authorized_user
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.fabricId, input.quantityMm, input.reason, input.createdAt,
      input.type, input.reference, input.authorizedUser,
    );
  }

  costForRemoval(fabricId: string, quantityMm: number): number {
    const stock = this.getStock(fabricId);
    if (stock.stock_qty_mm < quantityMm) {
      throw new FabricServiceError("INSUFFICIENT_STOCK", "Stock cannot be reduced below zero.");
    }
    return calculateProportionalValue(stock.stock_value_minor, quantityMm, stock.stock_qty_mm);
  }

  report(): InventoryReport {
    const rows = this.database.prepare(`
      SELECT id, sku, name, stock_qty_mm, purchase_cost_minor, stock_value_minor, reorder_threshold_mm, active
      FROM fabrics ORDER BY sku COLLATE NOCASE
    `).all() as ValuationRow[];
    const valuation = rows.map((row) => ({
      fabricId: row.id,
      sku: row.sku,
      name: row.name,
      stockQtyMm: row.stock_qty_mm,
      unitCostMinor: row.stock_qty_mm > 0
        ? calculateProportionalValue(row.stock_value_minor, 1000, row.stock_qty_mm)
        : row.purchase_cost_minor,
      valueMinor: row.stock_value_minor,
      reorderThresholdMm: row.reorder_threshold_mm,
      lowStock: row.active === 1 && row.stock_qty_mm <= row.reorder_threshold_mm,
    }));
    return {
      totalStockMm: rows.reduce((total, row) => total + row.stock_qty_mm, 0),
      totalValuationMinor: rows.reduce((total, row) => total + row.stock_value_minor, 0),
      lowStockCount: valuation.filter((row) => row.lowStock).length,
      valuation,
    };
  }

  movements(): InventoryMovement[] {
    const rows = this.database.prepare(`
      SELECT m.id, m.fabric_id, f.sku, f.name, m.quantity_mm, m.movement_type,
             m.reference, m.reason, m.authorized_user, m.created_at
      FROM stock_movements m
      JOIN fabrics f ON f.id = m.fabric_id
      ORDER BY m.created_at DESC, m.rowid DESC
    `).all() as MovementRow[];
    return rows.map((row) => ({
      id: row.id,
      fabricId: row.fabric_id,
      sku: row.sku,
      fabricName: row.name,
      quantityMm: row.quantity_mm,
      movementType: row.movement_type,
      reference: row.reference,
      reason: row.reason,
      authorizedUser: row.authorized_user,
      createdAt: row.created_at,
    }));
  }

  private getStock(fabricId: string): StockRow {
    const row = this.database.prepare(`
      SELECT stock_qty_mm, purchase_cost_minor, stock_value_minor FROM fabrics WHERE id = ?
    `).get(fabricId) as StockRow | undefined;
    if (!row) throw new FabricServiceError("NOT_FOUND", "Fabric product not found.");
    return row;
  }
}
