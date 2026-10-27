import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/main/database";
import { FabricService, FabricServiceError } from "../src/main/services/fabrics";
import {
  fabricInputSchema,
  stockAdjustmentSchema,
  createInvoiceSchema,
} from "../src/shared/contracts";

const migrationsDirectory = path.resolve("database/migrations");
const temporaryDirectories: string[] = [];

async function createService(): Promise<{ service: FabricService; close: () => void }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "greige-fabrics-"));
  temporaryDirectories.push(directory);
  const database = await openDatabase(path.join(directory, "pos.sqlite"), migrationsDirectory);
  return { service: new FabricService(database), close: () => database.close() };
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
      }));

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
      })).toThrowError(new FabricServiceError("INSUFFICIENT_STOCK", "Stock cannot be adjusted below zero."));

      service.adjustStock({
        fabricId: fabric.id,
        direction: "add",
        quantityMeters: 1,
        reason: "Opening stock",
      });
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
});
