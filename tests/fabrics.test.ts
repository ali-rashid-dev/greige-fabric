import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/main/database";
import { FabricService, FabricServiceError } from "../src/main/services/fabrics";
import { InventoryService } from "../src/main/services/inventory";
import { SupplierService } from "../src/main/services/suppliers";
import { CustomerService } from "../src/main/services/customers";
import {
  fabricInputSchema,
  stockAdjustmentSchema,
  createInvoiceSchema,
  supplierInputSchema,
  supplierPurchaseSchema,
  supplierPaymentSchema,
  customerInputSchema,
  customerReceiptSchema,
} from "../src/shared/contracts";

const migrationsDirectory = path.resolve("database/migrations");
const temporaryDirectories: string[] = [];

async function createService(): Promise<{
  database: Awaited<ReturnType<typeof openDatabase>>;
  service: FabricService;
  inventory: InventoryService;
  suppliers: SupplierService;
  customers: CustomerService;
  close: () => void;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "greige-fabrics-"));
  temporaryDirectories.push(directory);
  const database = await openDatabase(path.join(directory, "pos.sqlite"), migrationsDirectory);
  return {
    database,
    service: new FabricService(database),
    inventory: new InventoryService(database),
    suppliers: new SupplierService(database),
    customers: new CustomerService(database),
    close: () => database.close(),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

const sampleFabric = {
  sku: "gf-0001",
  name: "Greige Cotton Fabric",
  construction: "60 x 60",
  composition: "100% cotton",
  widthInches: 63,
  gsm: 110,
  purchaseCost: 145,
  sellingRate: 180,
  reorderThresholdMeters: 500,
};

describe("fabric quality catalog", () => {
  it("validates required fields and normalizes unique SKUs", async () => {
    expect(fabricInputSchema.safeParse({ ...sampleFabric, name: " " }).success).toBe(false);
    expect(fabricInputSchema.parse(sampleFabric).sku).toBe("GF-0001");

    const { service, close } = await createService();
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      expect(fabric.sku).toBe("GF-0001");
      expect(() => service.create(fabricInputSchema.parse({ ...sampleFabric, sku: "GF-0001" })))
        .toThrowError(new FabricServiceError("CONFLICT", "That SKU is already in use."));
      expect(service.list({ query: "gf-0001", status: "active" }).map((row) => row.id))
        .toEqual([fabric.id]);
      expect(service.list({ query: "", status: "low-stock" }).map((row) => row.sku))
        .toEqual(["GF-0001"]);
    } finally {
      close();
    }
  });

  it("keeps invoice line prices and fabric identity unchanged after rate edits", async () => {
    const { service, close } = await createService();
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      service.adjustStock(stockAdjustmentSchema.parse({
        fabricId: fabric.id,
        direction: "add",
        quantityMeters: 10,
        reason: "Opening stock",
        ownerPin: "123456",
      }), "Owner");

      const invoiceInput = createInvoiceSchema.parse({
        items: [{ fabricId: fabric.id, quantityMeters: 2.5 }],
      });
      const invoice = service.createInvoice(invoiceInput);
      expect(invoice.items[0]).toMatchObject({
        sku: "GF-0001",
        name: "Greige Cotton Fabric",
        quantityMm: 2500,
        unitPriceMinor: 18000,
        lineTotalMinor: 45000,
      });
      expect(service.get(fabric.id).fabric.stockMm).toBe(7500);

      const edited = service.update({
        ...fabricInputSchema.parse({ ...sampleFabric, name: "Cotton 60 x 60", sku: "GF-0001", sellingRate: 205 }),
        id: fabric.id,
      });
      expect(edited.sellingRateMinor).toBe(20500);

      const historicalInvoice = service.listInvoices()[0];
      expect(historicalInvoice.items[0]).toMatchObject({
        sku: "GF-0001",
        name: "Greige Cotton Fabric",
        unitPriceMinor: 18000,
        lineTotalMinor: 45000,
      });
      expect(service.get(fabric.id).invoices[0].items[0].unitPriceMinor).toBe(18000);
    } finally {
      close();
    }
  });

  it("prevents negative stock and preserves invoice history on deactivation", async () => {
    const { service, close } = await createService();
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      expect(() => service.adjustStock({
        fabricId: fabric.id,
        direction: "remove",
        quantityMeters: 1,
        reason: "Correction",
      }, "Owner")).toThrowError(new FabricServiceError("INSUFFICIENT_STOCK", "Stock cannot be adjusted below zero."));

      service.adjustStock({
        fabricId: fabric.id,
        direction: "add",
        quantityMeters: 1,
        reason: "Opening stock",
      }, "Owner");
      service.createInvoice(createInvoiceSchema.parse({
        items: [{ fabricId: fabric.id, quantityMeters: 1 }],
      }));
      service.setActive(fabric.id, false);

      expect(service.list({ query: "", status: "active" })).toEqual([]);
      expect(service.list({ query: "", status: "inactive" })).toHaveLength(1);
      expect(service.get(fabric.id).invoices).toHaveLength(1);
      expect(service.stockSummary().lowStockCount).toBe(0);
    } finally {
      close();
    }
  });

  it("includes inactive inventory in report totals and AP inventory reconciliation", async () => {
    const { database, service, inventory, close } = await createService();
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      service.adjustStock({
        fabricId: fabric.id,
        direction: "add",
        quantityMeters: 2,
        reason: "Initial receipt",
      }, "Owner");
      service.setActive(fabric.id, false);

      const report = inventory.report();
      const ledgerInventory = database.prepare(`
        SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS value
        FROM ledger_postings WHERE account_code = '1200'
      `).get() as { value: number };
      expect(report.totalStockMm).toBe(2000);
      expect(report.totalValuationMinor).toBe(29000);
      expect(report.totalValuationMinor).toBe(ledgerInventory.value);
      expect(report.lowStockCount).toBe(0);
      expect(report.valuation).toHaveLength(1);
      expect(report.valuation[0].lowStock).toBe(false);
    } finally {
      close();
    }
  });

  it("posts receipts and sales atomically using integer millimeters", async () => {
    const { database, service, suppliers, inventory, close } = await createService();
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      const supplier = suppliers.create(supplierInputSchema.parse({
        code: "SUP-001",
        name: "Cotton Mills",
        phone: "03000000000",
        openingBalance: 1000,
        ownerPin: "123456",
      }), "Owner");
      suppliers.receive(supplierPurchaseSchema.parse({
        supplierId: supplier.id,
        billNumber: "BILL-1001",
        reference: "Delivery note DN-1001",
        purchaseDate: "2026-10-27",
        additionalCosts: 0,
        paymentMode: "credit",
        amountPaid: 0,
        items: [{ fabricId: fabric.id, quantityMeters: 1000, unitCost: 145 }],
      }));
      expect(service.get(fabric.id).fabric.stockMm).toBe(1_000_000);

      service.createInvoice(createInvoiceSchema.parse({
        items: [{ fabricId: fabric.id, quantityMeters: 250 }],
      }));
      expect(service.get(fabric.id).fabric.stockMm).toBe(750_000);
      expect(inventory.movements().map((movement) => movement.quantityMm).sort((a, b) => a - b))
        .toEqual([-250000, 1_000_000]);

      const movementCount = inventory.movements().length;
      const invoiceCount = service.listInvoices().length;
      expect(() => service.createInvoice(createInvoiceSchema.parse({
        items: [{ fabricId: fabric.id, quantityMeters: 751 }],
      }))).toThrowError(new FabricServiceError(
        "INSUFFICIENT_STOCK",
        `Not enough stock for ${fabric.sku}.`,
      ));
      expect(service.get(fabric.id).fabric.stockMm).toBe(750_000);
      expect(inventory.movements()).toHaveLength(movementCount);
      expect(service.listInvoices()).toHaveLength(invoiceCount);

      suppliers.pay(supplierPaymentSchema.parse({
        supplierId: supplier.id,
        amount: 1000,
        account: "bank",
        reference: "Bank transfer",
        note: "Opening amount settled",
      }));
      const statement = suppliers.statement({
        supplierId: supplier.id,
        from: "2020-01-01",
        to: "2999-12-31",
      });
      expect(statement.closingBalanceMinor).toBe(14_500_000);
      expect(suppliers.reconcile()).toEqual({
        controlMinor: 14_500_000,
        subledgerMinor: 14_500_000,
        differenceMinor: 0,
      });
      expect(inventory.report().valuation[0]).toMatchObject({
        stockQtyMm: 750_000,
        valueMinor: 10_875_000,
      });
      const inventoryLedger = database.prepare(`
          SELECT SUM(debit_minor - credit_minor) AS value
          FROM ledger_postings WHERE account_code = '1200'
      `).get() as { value: number };
      expect(inventoryLedger.value).toBe(10_875_000);
    } finally {
      close();
    }
  });

  it("records authorized opening stock as a movement and inventory journal entry", async () => {
    const { service, inventory, close } = await createService();
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      inventory.openStock({
        fabricId: fabric.id,
        quantityMeters: 2500,
        unitCost: 145,
        reference: "OPEN-001",
        reason: "Opening inventory count",
      }, "Owner");
      expect(service.get(fabric.id).fabric.stockMm).toBe(2_500_000);
      expect(inventory.movements()[0]).toMatchObject({
        movementType: "opening",
        reference: "OPEN-001",
        authorizedUser: "Owner",
        quantityMm: 2_500_000,
      });

    } finally {
      close();
    }
  });

  it("calculates weighted-average cost for purchases and allocates extra costs", async () => {
    const { service, inventory, suppliers, close } = await createService();
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      inventory.openStock({
        fabricId: fabric.id,
        quantityMeters: 1000,
        unitCost: 120,
        reference: "OPEN-COST",
        reason: "Opening stock",
      }, "Owner");
      const supplier = suppliers.create(supplierInputSchema.parse({
        code: "SUP-COST",
        name: "Costing Supplier",
        phone: "03000000000",
        openingBalance: 0,
      }), "System");

      const details = suppliers.receive(supplierPurchaseSchema.parse({
        supplierId: supplier.id,
        billNumber: "BILL-WAC-1",
        reference: "INV-WAC-1",
        purchaseDate: "2026-10-27",
        additionalCosts: 0,
        paymentMode: "credit",
        amountPaid: 0,
        items: [{ fabricId: fabric.id, quantityMeters: 500, unitCost: 150 }],
      }));
      const report = inventory.report();
      expect(service.get(fabric.id).fabric.stockMm).toBe(1_500_000);
      expect(report.valuation[0].unitCostMinor).toBe(13_000);
      expect(report.valuation[0].valueMinor).toBe(19_500_000);
      expect(details.purchases[0]).toMatchObject({
        totalMinor: 7_500_000,
        paidMinor: 0,
        dueMinor: 7_500_000,
      });

      const otherFabric = service.create(fabricInputSchema.parse({
        ...sampleFabric,
        sku: "GF-0002",
        name: "Cotton 2",
      }));
      const cashPurchase = suppliers.receive(supplierPurchaseSchema.parse({
        supplierId: supplier.id,
        billNumber: "BILL-CASH-1",
        purchaseDate: "2026-10-27",
        additionalCosts: 0,
        paymentMode: "cash",
        amountPaid: 1000,
        items: [{ fabricId: otherFabric.id, quantityMeters: 10, unitCost: 100 }],
      }));
      expect(cashPurchase.purchases.find((purchase) => purchase.billNumber === "BILL-CASH-1"))
        .toMatchObject({ totalMinor: 100_000, paidMinor: 100_000, dueMinor: 0 });
      expect(cashPurchase.supplier.outstandingMinor).toBe(7_500_000);

      const allocated = suppliers.receive(supplierPurchaseSchema.parse({
        supplierId: supplier.id,
        billNumber: "BILL-WAC-2",
        reference: "INV-WAC-2",
        purchaseDate: "2026-10-27",
        additionalCosts: 300,
        additionalCostsDescription: "Freight and loading",
        paymentMode: "credit",
        amountPaid: 150,
        paymentAccount: "bank",
        items: [
          { fabricId: fabric.id, quantityMeters: 100, unitCost: 100 },
          { fabricId: otherFabric.id, quantityMeters: 200, unitCost: 200 },
        ],
      }));
      const secondPurchase = allocated.purchases.find((purchase) => purchase.billNumber === "BILL-WAC-2");
      expect(secondPurchase?.additionalCostsMinor).toBe(30_000);
      expect(secondPurchase?.items.reduce((sum, item) => sum + item.allocatedCostMinor, 0)).toBe(30_000);
      expect(secondPurchase?.paidMinor).toBe(15_000);
      expect(secondPurchase?.dueMinor).toBe(5_015_000);
      expect(allocated.supplier.outstandingMinor).toBe(12_515_000);
      const firstPurchase = allocated.purchases.find((purchase) => purchase.billNumber === "BILL-WAC-1");
      const paymentResult = suppliers.pay(supplierPaymentSchema.parse({
        supplierId: supplier.id,
        purchaseId: firstPurchase?.id,
        amount: 75_000,
        account: "cash",
        reference: "Paid first bill",
      }));
      expect(paymentResult.purchases.find((purchase) => purchase.id === firstPurchase?.id)?.dueMinor).toBe(0);
      expect(paymentResult.supplier.outstandingMinor).toBe(5_015_000);
      expect(suppliers.reconcile().differenceMinor).toBe(0);
    } finally {
      close();
    }
  });

  it("reconciles customer opening balance, credit sale, receipt and statement", async () => {
    const { database, service, inventory, customers, close } = await createService();
    try {
      const fabric = service.create(fabricInputSchema.parse({ ...sampleFabric, sellingRate: 250 }));
      inventory.openStock({
        fabricId: fabric.id,
        quantityMeters: 101,
        unitCost: 145,
        reference: "CUSTOMER-STOCK",
        reason: "Customer sale test stock",
      }, "Owner");

      const customerInput = customerInputSchema.parse({
        code: "CUS-001",
        name: "Wholesale Buyer",
        phone: "03000000000",
        address: "Lahore",
        openingBalance: 10_000,
        creditLimit: 35_000,
        paymentTermsDays: 30,
        ownerPin: "123456",
      });
      const customer = customers.create({
        code: customerInput.code,
        name: customerInput.name,
        phone: customerInput.phone,
        address: customerInput.address,
        openingBalance: customerInput.openingBalance,
        creditLimit: customerInput.creditLimit,
        paymentTermsDays: customerInput.paymentTermsDays,
      }, "Owner");

      const invoice = service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 100 }],
      }));
      expect(invoice).toMatchObject({
        customerId: customer.id,
        totalMinor: 2_500_000,
      });
      expect(customers.get(customer.id).customer.outstandingMinor).toBe(3_500_000);

      const invoiceCount = service.listInvoices().length;
      const movementCount = inventory.movements().length;
      expect(() => service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 1 }],
      }))).toThrowError(new FabricServiceError(
        "CONFLICT",
        "This sale would exceed the customer's credit limit.",
      ));
      expect(service.listInvoices()).toHaveLength(invoiceCount);
      expect(inventory.movements()).toHaveLength(movementCount);

      const receiptInput = customerReceiptSchema.parse({
        customerId: customer.id,
        amount: 15_000,
        account: "bank",
        reference: "Bank transfer",
        note: "Part payment",
      });
      const receiptResult = customers.receive(receiptInput);
      expect(receiptResult.customer.outstandingMinor).toBe(2_000_000);
      expect(receiptResult.receipts[0]).toMatchObject({
        account: "bank",
        amountMinor: 1_500_000,
        reference: "Bank transfer",
      });
      expect(receiptResult.sales[0]).toMatchObject({
        customerId: customer.id,
        customerCode: "CUS-001",
        customerName: "Wholesale Buyer",
      });

      const statement = customers.statement({
        customerId: customer.id,
        from: "2020-01-01",
        to: "2999-12-31",
      });
      expect(statement.openingBalanceMinor).toBe(0);
      expect(statement.closingBalanceMinor).toBe(2_000_000);
      expect(statement.lines.map((line) => [line.debitMinor, line.creditMinor]))
        .toEqual([[1_000_000, 0], [2_500_000, 0], [0, 1_500_000]]);

      const receivableControl = database.prepare(`
        SELECT COALESCE(SUM(debit_minor - credit_minor), 0) AS balance
        FROM ledger_postings WHERE account_code = '1300' AND customer_id = ?
      `).get(customer.id) as { balance: number };
      expect(receivableControl.balance).toBe(2_000_000);
    } finally {
      close();
    }
  });

  it("backs up an existing POS database before applying a new migration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "greige-migration-"));
    temporaryDirectories.push(directory);
    const migrations = path.join(directory, "migrations");
    await mkdir(migrations);
    await copyFile(
      path.join(migrationsDirectory, "001_initial.sql"),
      path.join(migrations, "001_initial.sql"),
    );
    const databasePath = path.join(directory, "pos.sqlite");

    let database = await openDatabase(databasePath, migrations);
    database.close();
    await writeFile(
      path.join(migrations, "002_gsm_index.sql"),
      "CREATE INDEX fabrics_gsm_idx ON fabrics(gsm);\n",
    );

    database = await openDatabase(databasePath, migrations);
    database.close();
    expect((await readdir(directory)).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
  });

  it("backfills existing movement balances and opening inventory value during migration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "greige-inventory-migration-"));
    temporaryDirectories.push(directory);
    const oldMigrations = path.join(directory, "old-migrations");
    await mkdir(oldMigrations);
    await copyFile(
      path.join(migrationsDirectory, "001_initial.sql"),
      path.join(oldMigrations, "001_initial.sql"),
    );
    const databasePath = path.join(directory, "existing-pos.sqlite");
    let database = await openDatabase(databasePath, oldMigrations);
    database.prepare(`
      INSERT INTO fabrics (
        id, sku, name, construction, composition, width_inches, gsm,
        purchase_cost_minor, selling_rate_minor, reorder_threshold_mm,
        created_at, updated_at
      ) VALUES ('fabric-existing', 'GF-OLD', 'Legacy fabric', '60x60', 'Cotton', 63, 110,
        14500, 18000, 500000, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO stock_movements (id, fabric_id, quantity_mm, reason, created_at)
      VALUES ('movement-in', 'fabric-existing', 10000, 'Opening inventory', '2025-01-01T00:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO stock_movements (id, fabric_id, quantity_mm, reason, created_at)
      VALUES ('movement-out', 'fabric-existing', -2500, 'Legacy sale', '2025-01-02T00:00:00.000Z')
    `).run();
    database.close();

    database = await openDatabase(databasePath, migrationsDirectory);
    try {
      const balance = database.prepare(`
        SELECT stock_qty_mm, stock_value_minor FROM fabrics WHERE id = 'fabric-existing'
      `).get() as { stock_qty_mm: number; stock_value_minor: number };
      expect(balance).toEqual({ stock_qty_mm: 7500, stock_value_minor: 108750 });
      const ledgerInventory = database.prepare(`
        SELECT SUM(debit_minor - credit_minor) AS value
        FROM ledger_postings WHERE account_code = '1200'
      `).get() as { value: number };
      expect(ledgerInventory.value).toBe(108750);
      expect((await readdir(directory)).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
