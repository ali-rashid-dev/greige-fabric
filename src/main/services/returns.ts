import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PurchaseReturnInput, ReturnReversalInput, SalesReturnInput } from "../../shared/contracts";
import type {
  AuditLogEntry,
  PurchaseReturnSource,
  ReturnData,
  ReturnRecord,
  SalesReturnSource,
} from "../../shared/types";
import { allocateMinorValue, calculateProportionalValue, postJournal } from "./accounting";
import { FabricServiceError } from "./errors";
import { InventoryService } from "./inventory";
import { writeAuditLog } from "./audit";

interface InvoiceRow {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  discount_minor: number;
  created_at: string;
}

interface InvoiceItemRow {
  id: string;
  fabric_id: string;
  sku: string;
  name: string;
  quantity_mm: number;
  unit_price_minor: number;
  line_total_minor: number;
  cost_of_goods_sold_minor: number;
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

interface ReturnRow {
  id: string;
  return_number: string;
  source_id: string;
  source_reference: string;
  party_name: string;
  settlement_type: ReturnRecord["settlementType"];
  total_minor: number;
  reason: string;
  created_at: string;
  authorized_user: string;
  reversed_at: string | null;
  reversal_reason: string;
  return_type: ReturnRecord["returnType"];
}

function mapReturn(row: ReturnRow): ReturnRecord {
  return {
    id: row.id,
    returnNumber: row.return_number,
    returnType: row.return_type,
    sourceId: row.source_id,
    sourceReference: row.source_reference,
    partyName: row.party_name,
    settlementType: row.settlement_type,
    totalMinor: row.total_minor,
    reason: row.reason,
    createdAt: row.created_at,
    authorizedUser: row.authorized_user,
    reversedAt: row.reversed_at ?? undefined,
    reversalReason: row.reversal_reason || undefined,
  };
}

export class ReturnsService {
  private readonly inventory: InventoryService;

  constructor(private readonly database: Database.Database) {
    this.inventory = new InventoryService(database);
  }

  data(): ReturnData {
    return {
      sales: this.salesSources(),
      purchases: this.purchaseSources(),
      history: this.history(),
      auditLog: this.auditLog(),
    };
  }

  private salesSources(): SalesReturnSource[] {
    const invoices = this.database.prepare(`
      SELECT i.id, i.invoice_number, i.customer_id, c.code AS customer_code,
        c.name AS customer_name, i.discount_minor, i.created_at
      FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
      ORDER BY i.created_at DESC
    `).all() as InvoiceRow[];
    const sources: SalesReturnSource[] = [];
    for (const invoice of invoices) {
      const items = this.database.prepare(`
        SELECT ii.id, ii.fabric_id, ii.sku_snapshot AS sku, ii.name_snapshot AS name,
          ii.quantity_mm, ii.unit_price_minor, ii.line_total_minor, ii.cost_of_goods_sold_minor,
          COALESCE((
            SELECT SUM(sri.quantity_mm)
            FROM sales_return_items sri JOIN sales_returns sr ON sr.id = sri.sales_return_id
            WHERE sri.invoice_item_id = ii.id AND sr.reversed_at IS NULL
          ), 0) AS returned_quantity_mm
        FROM invoice_items ii WHERE ii.invoice_id = ? ORDER BY ii.rowid
      `).all(invoice.id) as Array<InvoiceItemRow & { returned_quantity_mm: number }>;
      const discounts = allocateMinorValue(invoice.discount_minor, items.map((item) => item.line_total_minor));
      const sourceItems = items.map((item, index) => ({
        sourceItemId: item.id,
        fabricId: item.fabric_id,
        sku: item.sku,
        name: item.name,
        quantityMm: item.quantity_mm,
        returnedQuantityMm: item.returned_quantity_mm,
        remainingQuantityMm: item.quantity_mm - item.returned_quantity_mm,
        unitPriceMinor: item.unit_price_minor,
        lineTotalMinor: item.line_total_minor,
        costOfGoodsSoldMinor: item.cost_of_goods_sold_minor,
        netLineMinor: item.line_total_minor - discounts[index],
      }));
      if (!sourceItems.some((item) => item.remainingQuantityMm > 0)) continue;
      sources.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        customerId: invoice.customer_id ?? undefined,
        customerCode: invoice.customer_code ?? undefined,
        customerName: invoice.customer_name ?? undefined,
        createdAt: invoice.created_at,
        items: sourceItems.map((item) => ({
          sourceItemId: item.sourceItemId,
          fabricId: item.fabricId,
          sku: item.sku,
          name: item.name,
          quantityMm: item.quantityMm,
          returnedQuantityMm: item.returnedQuantityMm,
          remainingQuantityMm: item.remainingQuantityMm,
          unitPriceMinor: item.unitPriceMinor,
          lineTotalMinor: item.lineTotalMinor,
          costOfGoodsSoldMinor: item.costOfGoodsSoldMinor,
        })),
      });
    }
    return sources;
  }

  private purchaseSources(): PurchaseReturnSource[] {
    const purchases = this.database.prepare(`
      SELECT pu.id, pu.bill_number, pu.supplier_id, s.code AS supplier_code,
        s.name AS supplier_name, pu.purchase_date
      FROM supplier_purchases pu JOIN suppliers s ON s.id = pu.supplier_id
      ORDER BY pu.created_at DESC
    `).all() as Array<{
      id: string;
      bill_number: string;
      supplier_id: string;
      supplier_code: string;
      supplier_name: string;
      purchase_date: string;
    }>;
    const sources: PurchaseReturnSource[] = [];
    for (const purchase of purchases) {
      const items = this.database.prepare(`
        SELECT pi.id, pi.fabric_id, f.sku, f.name, pi.quantity_mm, pi.unit_cost_minor,
          pi.line_total_minor,
          COALESCE((
            SELECT SUM(pri.quantity_mm)
            FROM purchase_return_items pri JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
            WHERE pri.purchase_item_id = pi.id AND pr.reversed_at IS NULL
          ), 0) AS returned_quantity_mm
        FROM supplier_purchase_items pi JOIN fabrics f ON f.id = pi.fabric_id
        WHERE pi.purchase_id = ? ORDER BY pi.rowid
      `).all(purchase.id) as Array<PurchaseItemRow & { returned_quantity_mm: number }>;
      const sourceItems = items.map((item) => ({
        sourceItemId: item.id,
        fabricId: item.fabric_id,
        sku: item.sku,
        name: item.name,
        quantityMm: item.quantity_mm,
        returnedQuantityMm: item.returned_quantity_mm,
        remainingQuantityMm: item.quantity_mm - item.returned_quantity_mm,
        unitCostMinor: item.unit_cost_minor,
        lineTotalMinor: item.line_total_minor,
      }));
      if (!sourceItems.some((item) => item.remainingQuantityMm > 0)) continue;
      sources.push({
        purchaseId: purchase.id,
        billNumber: purchase.bill_number,
        supplierId: purchase.supplier_id,
        supplierCode: purchase.supplier_code,
        supplierName: purchase.supplier_name,
        purchaseDate: purchase.purchase_date,
        items: sourceItems,
      });
    }
    return sources;
  }

  private history(): ReturnRecord[] {
    const rows = this.database.prepare(`
      SELECT r.id, r.return_number, r.invoice_id AS source_id, i.invoice_number AS source_reference,
        COALESCE(c.name, 'Walk-in') AS party_name, r.settlement_type, r.total_minor,
        r.reason, r.created_at, r.authorized_user, r.reversed_at, r.reversal_reason,
        'sales_return' AS return_type
      FROM sales_returns r JOIN invoices i ON i.id = r.invoice_id
        LEFT JOIN customers c ON c.id = r.customer_id
      UNION ALL
      SELECT r.id, r.return_number, r.purchase_id, p.bill_number, s.name,
        r.settlement_type, r.total_minor, r.reason, r.created_at, r.authorized_user,
        r.reversed_at, r.reversal_reason, 'purchase_return'
      FROM purchase_returns r JOIN supplier_purchases p ON p.id = r.purchase_id
        JOIN suppliers s ON s.id = r.supplier_id
      ORDER BY 9 DESC
    `).all() as ReturnRow[];
    return rows.map(mapReturn);
  }

  private auditLog(): AuditLogEntry[] {
    const rows = this.database.prepare(`
      SELECT id, actor, action, source_type, source_id, reason, created_at
      FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT 250
    `).all() as Array<{
      id: string;
      actor: string;
      action: string;
      source_type: string;
      source_id: string;
      reason: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      sourceType: row.source_type,
      sourceId: row.source_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  createSales(input: Omit<SalesReturnInput, "ownerPin">, authorizedUser: string): ReturnRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const datePart = now.slice(0, 10).replaceAll("-", "");
    const returnNumber = `SR-${datePart}-${id.slice(0, 6).toUpperCase()}`;
    const transaction = this.database.transaction(() => {
      const invoice = this.database.prepare(`
        SELECT i.id, i.invoice_number, i.customer_id, i.discount_minor, i.created_at,
          i.total_minor, i.amount_received_minor, i.returned_minor
        FROM invoices i WHERE i.id = ?
      `).get(input.invoiceId) as (Pick<InvoiceRow, "id" | "invoice_number" | "customer_id" | "discount_minor" | "created_at">
        & { total_minor: number; amount_received_minor: number; returned_minor: number }) | undefined;
      if (!invoice) throw new FabricServiceError("NOT_FOUND", "Original invoice not found.");
      if (input.settlementType === "customer_credit" && !invoice.customer_id) {
        throw new FabricServiceError("VALIDATION", "Walk-in sales must be refunded to a payment account.");
      }
      if (input.settlementType === "refund") this.requirePaymentAccount(input.paymentAccountCode ?? "");

      const invoiceItems = this.database.prepare(`
        SELECT id, fabric_id, quantity_mm, unit_price_minor, line_total_minor, cost_of_goods_sold_minor
        FROM invoice_items WHERE invoice_id = ? ORDER BY rowid
      `).all(invoice.id) as Array<InvoiceItemRow>;
      const discountAllocations = allocateMinorValue(invoice.discount_minor, invoiceItems.map((item) => item.line_total_minor));
      const netAmounts = new Map(invoiceItems.map((item, index) => [
        item.id,
        item.line_total_minor - discountAllocations[index],
      ]));
      let totalMinor = 0;
      let costMinor = 0;
      let receivableMinor = 0;
      let advanceMinor = 0;
      const returnItems: Array<{
        source: InvoiceItemRow;
        quantityMm: number;
        saleable: number;
        returnedMinor: number;
        costMinor: number;
      }> = [];
      const postingLines: Array<{
        accountCode: string;
        debitMinor?: number;
        creditMinor?: number;
        customerId?: string;
      }> = [];
      const sourceItemIds = new Set<string>();
      for (const line of input.items) {
        if (sourceItemIds.has(line.sourceItemId)) {
          throw new FabricServiceError("VALIDATION", "Each invoice line may appear only once in a return.");
        }
        sourceItemIds.add(line.sourceItemId);
        const source = invoiceItems.find((item) => item.id === line.sourceItemId);
        if (!source) throw new FabricServiceError("VALIDATION", "A return line does not belong to the selected invoice.");
        const quantityMm = Math.round(line.quantityMeters * 1000);
        const prior = this.database.prepare(`
          SELECT COALESCE(SUM(i.quantity_mm), 0) AS quantity_mm,
            COALESCE(SUM(i.returned_minor), 0) AS returned_minor,
            COALESCE(SUM(CASE WHEN i.saleable = 1 THEN i.quantity_mm ELSE 0 END), 0) AS saleable_quantity_mm,
            COALESCE(SUM(i.cost_minor), 0) AS cost_minor
          FROM sales_return_items i JOIN sales_returns r ON r.id = i.sales_return_id
          WHERE i.invoice_item_id = ? AND r.reversed_at IS NULL
        `).get(source.id) as {
          quantity_mm: number;
          returned_minor: number;
          saleable_quantity_mm: number;
          cost_minor: number;
        };
        if (quantityMm > source.quantity_mm - prior.quantity_mm) {
          throw new FabricServiceError("VALIDATION", "Return quantity exceeds the invoice line's eligible remaining quantity.");
        }
        const returnedAmount = calculateProportionalValue(
          netAmounts.get(source.id) ?? 0,
          prior.quantity_mm + quantityMm,
          source.quantity_mm,
        ) - prior.returned_minor;
        const saleableQuantityMm = prior.saleable_quantity_mm + (line.saleable ? quantityMm : 0);
        const lineCostMinor = line.saleable
          ? calculateProportionalValue(source.cost_of_goods_sold_minor, saleableQuantityMm, source.quantity_mm) - prior.cost_minor
          : 0;
        totalMinor += returnedAmount;
        costMinor += lineCostMinor;
        returnItems.push({
          source,
          quantityMm,
          saleable: line.saleable ? 1 : 0,
          returnedMinor: returnedAmount,
          costMinor: lineCostMinor,
        });
        if (line.saleable) {
          this.inventory.postMovement({
            fabricId: source.fabric_id,
            quantityMm,
            type: "sales_return",
            reference: returnNumber,
            reason: input.reason,
            authorizedUser,
            createdAt: now,
            incomingValueMinor: lineCostMinor,
          });
        }
      }
      if (input.settlementType === "customer_credit") {
        receivableMinor = Math.min(
          totalMinor,
          Math.max(0, invoice.total_minor - invoice.amount_received_minor - invoice.returned_minor),
        );
        advanceMinor = totalMinor - receivableMinor;
      }
      if (input.settlementType === "refund") {
        const refunds = this.database.prepare(`
          SELECT COALESCE(SUM(total_minor), 0) AS refunded_minor
          FROM sales_returns WHERE invoice_id = ? AND settlement_type = 'refund'
            AND reversed_at IS NULL
        `).get(invoice.id) as { refunded_minor: number };
        if (totalMinor > invoice.amount_received_minor - refunds.refunded_minor) {
          throw new FabricServiceError(
            "VALIDATION",
            "Refund exceeds the amount received for this invoice; use a customer credit note for the unpaid portion.",
          );
        }
      }
      if (receivableMinor > 0) {
        this.database.prepare(`
          UPDATE invoices SET returned_minor = returned_minor + ? WHERE id = ?
        `).run(receivableMinor, invoice.id);
      }
      this.database.prepare(`
        INSERT INTO sales_returns (
          id, return_number, invoice_id, customer_id, settlement_type, payment_account_code,
          reason, total_minor, receivable_minor, advance_minor, created_at, authorized_user
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, returnNumber, invoice.id, invoice.customer_id,
        input.settlementType, input.paymentAccountCode ?? null,
        input.reason, totalMinor, receivableMinor, advanceMinor, now, authorizedUser,
      );
      const insertReturnItem = this.database.prepare(`
        INSERT INTO sales_return_items
          (id, sales_return_id, invoice_item_id, quantity_mm, saleable, returned_minor, cost_minor)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of returnItems) {
        insertReturnItem.run(
          randomUUID(), id, item.source.id, item.quantityMm, item.saleable,
          item.returnedMinor, item.costMinor,
        );
      }
      if (totalMinor > 0) {
        if (input.settlementType === "refund") {
          postingLines.push(
            { accountCode: "4000", debitMinor: totalMinor },
            { accountCode: input.paymentAccountCode ?? "", creditMinor: totalMinor },
          );
        } else {
          if (receivableMinor > 0) postingLines.push({
            accountCode: "1300", customerId: invoice.customer_id ?? undefined, creditMinor: receivableMinor,
          });
          if (advanceMinor > 0) postingLines.push({
            accountCode: "2200", customerId: invoice.customer_id ?? undefined, creditMinor: advanceMinor,
          });
          postingLines.push({ accountCode: "4000", debitMinor: totalMinor });
        }
      }
      if (costMinor > 0) {
        postingLines.push(
          { accountCode: "1200", debitMinor: costMinor },
          { accountCode: "5000", creditMinor: costMinor },
        );
      }
      if (postingLines.length > 0) {
        postJournal(this.database, "sales_return", returnNumber, now, postingLines, authorizedUser, id);
      }
      this.writeAudit(authorizedUser, "sales_return", "sales_return", id, input.reason, now);
    });
    transaction.immediate();
    return this.history().find((item) => item.id === id)!;
  }

  createPurchase(input: Omit<PurchaseReturnInput, "ownerPin">, authorizedUser: string): ReturnRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const datePart = now.slice(0, 10).replaceAll("-", "");
    const returnNumber = `PR-${datePart}-${id.slice(0, 6).toUpperCase()}`;
    const transaction = this.database.transaction(() => {
      const purchase = this.database.prepare(`
        SELECT id, supplier_id, bill_number, paid_minor FROM supplier_purchases WHERE id = ?
      `).get(input.purchaseId) as {
        id: string;
        supplier_id: string;
        bill_number: string;
        paid_minor: number;
      } | undefined;
      if (!purchase) throw new FabricServiceError("NOT_FOUND", "Original supplier purchase not found.");
      if (input.settlementType === "refund") this.requirePaymentAccount(input.paymentAccountCode ?? "");

      let totalMinor = 0;
      const returnItems: Array<{
        source: { id: string; fabric_id: string };
        quantityMm: number;
        valueMinor: number;
      }> = [];
      const sourceItemIds = new Set<string>();
      for (const line of input.items) {
        if (sourceItemIds.has(line.sourceItemId)) {
          throw new FabricServiceError("VALIDATION", "Each purchase line may appear only once in a return.");
        }
        sourceItemIds.add(line.sourceItemId);
        const source = this.database.prepare(`
          SELECT id, fabric_id, quantity_mm FROM supplier_purchase_items
          WHERE id = ? AND purchase_id = ?
        `).get(line.sourceItemId, purchase.id) as { id: string; fabric_id: string; quantity_mm: number } | undefined;
        if (!source) throw new FabricServiceError("VALIDATION", "A return line does not belong to the selected purchase.");
        const quantityMm = Math.round(line.quantityMeters * 1000);
        const prior = this.database.prepare(`
          SELECT COALESCE(SUM(i.quantity_mm), 0) AS quantity_mm
          FROM purchase_return_items i JOIN purchase_returns r ON r.id = i.purchase_return_id
          WHERE i.purchase_item_id = ? AND r.reversed_at IS NULL
        `).get(source.id) as { quantity_mm: number };
        if (quantityMm > source.quantity_mm - prior.quantity_mm) {
          throw new FabricServiceError("VALIDATION", "Return quantity exceeds the purchase line's eligible remaining quantity.");
        }
        const valueMinor = this.inventory.costForRemoval(source.fabric_id, quantityMm);
        totalMinor += valueMinor;
        this.inventory.postMovement({
          fabricId: source.fabric_id,
          quantityMm: -quantityMm,
          type: "purchase_return",
          reference: returnNumber,
          reason: input.reason,
          authorizedUser,
          createdAt: now,
        });
        returnItems.push({ source, quantityMm, valueMinor });
      }
      if (input.settlementType === "refund") {
        const refunds = this.database.prepare(`
          SELECT COALESCE(SUM(total_minor), 0) AS refunded_minor
          FROM purchase_returns WHERE purchase_id = ? AND settlement_type = 'refund'
            AND reversed_at IS NULL
        `).get(purchase.id) as { refunded_minor: number };
        if (totalMinor > purchase.paid_minor - refunds.refunded_minor) {
          throw new FabricServiceError(
            "VALIDATION",
            "Refund exceeds the amount paid for this purchase; use a supplier debit note for the unpaid portion.",
          );
        }
      }
      this.database.prepare(`
        INSERT INTO purchase_returns (
          id, return_number, purchase_id, supplier_id, settlement_type, payment_account_code,
          reason, total_minor, created_at, authorized_user
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, returnNumber, purchase.id, purchase.supplier_id, input.settlementType,
        input.paymentAccountCode ?? null, input.reason, totalMinor, now, authorizedUser,
      );
      const insertReturnItem = this.database.prepare(`
        INSERT INTO purchase_return_items
          (id, purchase_return_id, purchase_item_id, quantity_mm, value_minor)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const item of returnItems) {
        insertReturnItem.run(randomUUID(), id, item.source.id, item.quantityMm, item.valueMinor);
      }
      if (totalMinor > 0) {
        const lines = input.settlementType === "supplier_credit"
          ? [
            { accountCode: "2100", supplierId: purchase.supplier_id, debitMinor: totalMinor },
            { accountCode: "1200", creditMinor: totalMinor },
          ]
          : [
            { accountCode: input.paymentAccountCode ?? "", debitMinor: totalMinor },
            { accountCode: "1200", creditMinor: totalMinor },
          ];
        postJournal(this.database, "purchase_return", returnNumber, now, lines, authorizedUser, id);
      }
      this.writeAudit(authorizedUser, "purchase_return", "purchase_return", id, input.reason, now);
    });
    transaction.immediate();
    return this.history().find((item) => item.id === id)!;
  }

  reverse(input: Omit<ReturnReversalInput, "ownerPin">, authorizedUser: string): ReturnRecord {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      if (input.returnType === "sales_return") this.reverseSales(input, authorizedUser, now);
      else this.reversePurchase(input, authorizedUser, now);
    });
    transaction.immediate();
    return this.history().find((item) => item.id === input.returnId)!;
  }

  private reverseSales(input: Omit<ReturnReversalInput, "ownerPin">, authorizedUser: string, now: string): void {
    const record = this.database.prepare(`
      SELECT id, return_number, invoice_id, customer_id, settlement_type, payment_account_code,
        total_minor, receivable_minor, advance_minor, reversed_at
      FROM sales_returns WHERE id = ?
    `).get(input.returnId) as {
      id: string;
      return_number: string;
      invoice_id: string;
      customer_id: string | null;
      settlement_type: "refund" | "customer_credit";
      payment_account_code: string | null;
      total_minor: number;
      receivable_minor: number;
      advance_minor: number;
      reversed_at: string | null;
    } | undefined;
    if (!record) throw new FabricServiceError("NOT_FOUND", "Sales return not found.");
    if (record.reversed_at) throw new FabricServiceError("CONFLICT", "This return has already been reversed.");
    if (record.receivable_minor > 0) {
      const result = this.database.prepare(`
        UPDATE invoices SET returned_minor = returned_minor - ?
        WHERE id = ? AND returned_minor >= ?
      `).run(record.receivable_minor, record.invoice_id, record.receivable_minor);
      if (result.changes === 0) {
        throw new FabricServiceError("CONFLICT", "The return can no longer be reversed against this invoice.");
      }
    }
    const items = this.database.prepare(`
      SELECT invoice_item_id, quantity_mm, saleable, cost_minor
      FROM sales_return_items WHERE sales_return_id = ?
    `).all(record.id) as Array<{
      invoice_item_id: string;
      quantity_mm: number;
      saleable: number;
      cost_minor: number;
    }>;
    let inventoryCostMinor = 0;
    for (const item of items) {
      if (item.saleable !== 1) continue;
      const source = this.database.prepare("SELECT fabric_id FROM invoice_items WHERE id = ?")
        .get(item.invoice_item_id) as { fabric_id: string };
      const costMinor = this.inventory.costForRemoval(source.fabric_id, item.quantity_mm);
      inventoryCostMinor += costMinor;
      this.inventory.postMovement({
        fabricId: source.fabric_id,
        quantityMm: -item.quantity_mm,
        type: "return_reversal",
        reference: record.return_number,
        reason: input.reason,
        authorizedUser,
        createdAt: now,
      });
    }
    this.database.prepare(`
      UPDATE sales_returns SET reversed_at = ?, reversal_reason = ? WHERE id = ?
    `).run(now, input.reason, record.id);
    const lines: Array<{ accountCode: string; debitMinor?: number; creditMinor?: number; customerId?: string }> = [];
    if (record.total_minor > 0) {
      if (record.settlement_type === "refund") {
        lines.push(
          { accountCode: record.payment_account_code ?? "", debitMinor: record.total_minor },
          { accountCode: "4000", creditMinor: record.total_minor },
        );
      } else {
        if (record.receivable_minor > 0) lines.push({
          accountCode: "1300", customerId: record.customer_id ?? undefined, debitMinor: record.receivable_minor,
        });
        if (record.advance_minor > 0) lines.push({
          accountCode: "2200", customerId: record.customer_id ?? undefined, debitMinor: record.advance_minor,
        });
        lines.push({ accountCode: "4000", creditMinor: record.total_minor });
      }
    }
    if (inventoryCostMinor > 0) {
      lines.push(
        { accountCode: "5000", debitMinor: inventoryCostMinor },
        { accountCode: "1200", creditMinor: inventoryCostMinor },
      );
    }
    if (lines.length > 0) {
      const original = this.database.prepare(`
        SELECT id FROM ledger_transactions WHERE source_key = ?
      `).get(`sales_return:${record.id}`) as { id: string } | undefined;
      postJournal(
        this.database, "sales_return_reversal", record.return_number, now, lines,
        authorizedUser, `return-reversal:${record.id}`, original?.id, input.reason,
      );
    }
    this.writeAudit(authorizedUser, "sales_return_reversal", "sales_return", record.id, input.reason, now);
  }

  private reversePurchase(input: Omit<ReturnReversalInput, "ownerPin">, authorizedUser: string, now: string): void {
    const record = this.database.prepare(`
      SELECT id, return_number, supplier_id, settlement_type, payment_account_code,
        reversed_at FROM purchase_returns WHERE id = ?
    `).get(input.returnId) as {
      id: string;
      return_number: string;
      supplier_id: string;
      settlement_type: "supplier_credit" | "refund";
      payment_account_code: string | null;
      reversed_at: string | null;
    } | undefined;
    if (!record) throw new FabricServiceError("NOT_FOUND", "Purchase return not found.");
    if (record.reversed_at) throw new FabricServiceError("CONFLICT", "This return has already been reversed.");
    const items = this.database.prepare(`
      SELECT purchase_item_id, quantity_mm, value_minor
      FROM purchase_return_items WHERE purchase_return_id = ?
    `).all(record.id) as Array<{ purchase_item_id: string; quantity_mm: number; value_minor: number }>;
    const totalMinor = items.reduce((sum, item) => sum + item.value_minor, 0);
    for (const item of items) {
      const source = this.database.prepare("SELECT fabric_id FROM supplier_purchase_items WHERE id = ?")
        .get(item.purchase_item_id) as { fabric_id: string };
      this.inventory.postMovement({
        fabricId: source.fabric_id,
        quantityMm: item.quantity_mm,
        type: "return_reversal",
        reference: record.return_number,
        reason: input.reason,
        authorizedUser,
        createdAt: now,
        incomingValueMinor: item.value_minor,
      });
    }
    this.database.prepare(`
      UPDATE purchase_returns SET reversed_at = ?, reversal_reason = ? WHERE id = ?
    `).run(now, input.reason, record.id);
    if (totalMinor > 0) {
      const lines = record.settlement_type === "supplier_credit"
        ? [
          { accountCode: "1200", debitMinor: totalMinor },
          { accountCode: "2100", supplierId: record.supplier_id, creditMinor: totalMinor },
        ]
        : [
          { accountCode: "1200", debitMinor: totalMinor },
          { accountCode: record.payment_account_code ?? "", creditMinor: totalMinor },
        ];
      const original = this.database.prepare(`
        SELECT id FROM ledger_transactions WHERE source_key = ?
      `).get(`purchase_return:${record.id}`) as { id: string } | undefined;
      postJournal(
        this.database, "purchase_return_reversal", record.return_number, now, lines,
        authorizedUser, `return-reversal:${record.id}`, original?.id, input.reason,
      );
    }
    this.writeAudit(authorizedUser, "purchase_return_reversal", "purchase_return", record.id, input.reason, now);
  }

  private requirePaymentAccount(code: string): void {
    const account = this.database.prepare(`
      SELECT 1 FROM ledger_accounts WHERE code = ? AND account_type = 'asset' AND is_payment_account = 1
    `).get(code);
    if (!account) throw new FabricServiceError("VALIDATION", "Choose a configured cash or payment account.");
  }

  private writeAudit(actor: string, action: string, sourceType: string, sourceId: string, reason: string, createdAt: string): void {
    writeAuditLog(this.database, actor, action, sourceType, sourceId, reason, createdAt);
  }
}
