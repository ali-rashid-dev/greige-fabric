import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/main/database";
import { FabricService, FabricServiceError } from "../src/main/services/fabrics";
import { InventoryService } from "../src/main/services/inventory";
import { SupplierService } from "../src/main/services/suppliers";
import { CustomerService } from "../src/main/services/customers";
import { AccountingService } from "../src/main/services/accounting";
import { ExpenseService } from "../src/main/services/expenses";
import { ReportsService } from "../src/main/services/reports";
import { ReturnsService } from "../src/main/services/returns";
import { BackupService } from "../src/main/services/backups";
import {
  fabricInputSchema,
  stockAdjustmentSchema,
  createInvoiceSchema,
  supplierInputSchema,
  supplierPurchaseSchema,
  supplierPaymentSchema,
  customerInputSchema,
  customerReceiptSchema,
  accountingClosePeriodSchema,
  accountingEntryReversalSchema,
  accountingManualEntrySchema,
  accountingOpeningBalancesSchema,
  backupAuthorizationSchema,
  backupScheduleSchema,
  printDocumentSchema,
} from "../src/shared/contracts";

const migrationsDirectory = path.resolve("database/migrations");
const temporaryDirectories: string[] = [];

async function createService(): Promise<{
  database: Awaited<ReturnType<typeof openDatabase>>;
  service: FabricService;
  inventory: InventoryService;
  suppliers: SupplierService;
  customers: CustomerService;
  accounting: AccountingService;
  expenses: ExpenseService;
  reports: ReportsService;
  returns: ReturnsService;
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
    accounting: new AccountingService(database),
    expenses: new ExpenseService(database),
    reports: new ReportsService(database),
    returns: new ReturnsService(database),
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
  it("returns saleable fabric against the original invoice with bounded quantity and balanced reversal", async () => {
    const { database, service, inventory, customers, returns, accounting, close } = await createService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      inventory.openStock({
        fabricId: fabric.id,
        quantityMeters: 200,
        unitCost: 145,
        reference: "RETURNS-OPENING-STOCK",
        reason: "Returns acceptance stock",
      }, "Owner");
      const customer = customers.create({
        code: "CUS-RETURN",
        name: "Return Customer",
        phone: "",
        address: "",
        openingBalance: 0,
        creditLimit: 0,
        paymentTermsDays: 0,
      }, "System");
      const invoice = service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 100, unitRate: 180 }],
        receivedAmount: 18_000,
      }));
      const originalInvoice = service.listInvoices()[0];

      const salesSource = returns.data().sales.find((source) => source.invoiceId === invoice.id);
      expect(salesSource?.items[0]).toMatchObject({
        quantityMm: 100_000,
        remainingQuantityMm: 100_000,
        costOfGoodsSoldMinor: 1_450_000,
      });
      const returned = returns.createSales({
        invoiceId: invoice.id,
        settlementType: "refund",
        paymentAccountCode: "1000",
        reason: "Ten meters passed inspection",
        items: [{ sourceItemId: invoice.items[0].id, quantityMeters: 10, saleable: true }],
      }, "Owner");
      expect(returned).toMatchObject({
        returnType: "sales_return",
        sourceId: invoice.id,
        sourceReference: invoice.invoiceNumber,
        totalMinor: 180_000,
        reason: "Ten meters passed inspection",
      });
      expect(service.get(fabric.id).fabric.stockMm).toBe(110_000);
      expect(service.listInvoices()[0]).toEqual(originalInvoice);
      expect(returns.data().sales[0].items[0].remainingQuantityMm).toBe(90_000);
      expect(() => returns.createSales({
        invoiceId: invoice.id,
        settlementType: "refund",
        paymentAccountCode: "1000",
        reason: "Duplicate line attempt",
        items: [
          { sourceItemId: invoice.items[0].id, quantityMeters: 45, saleable: false },
          { sourceItemId: invoice.items[0].id, quantityMeters: 45, saleable: false },
        ],
      }, "Owner")).toThrowError(/Each invoice line may appear only once/);
      expect(service.get(fabric.id).fabric.stockMm).toBe(110_000);
      expect(() => returns.createSales({
        invoiceId: invoice.id,
        settlementType: "refund",
        paymentAccountCode: "1000",
        reason: "Over return attempt",
        items: [{ sourceItemId: invoice.items[0].id, quantityMeters: 91, saleable: true }],
      }, "Owner")).toThrowError(/eligible remaining quantity/);

      const returnTransaction = database.prepare(`
        SELECT id FROM ledger_transactions WHERE source_key = ?
      `).get(`sales_return:${returned.id}`) as { id: string };
      const postings = database.prepare(`
        SELECT account_code, SUM(debit_minor) AS debit, SUM(credit_minor) AS credit
        FROM ledger_postings WHERE transaction_id = ? GROUP BY account_code ORDER BY account_code
      `).all(returnTransaction.id) as Array<{ account_code: string; debit: number; credit: number }>;
      expect(postings).toEqual([
        { account_code: "1000", debit: 0, credit: 180_000 },
        { account_code: "1200", debit: 145_000, credit: 0 },
        { account_code: "4000", debit: 180_000, credit: 0 },
        { account_code: "5000", debit: 0, credit: 145_000 },
      ]);
      expect(accounting.trialBalance("2026-10-27").isBalanced).toBe(true);

      const reversed = returns.reverse({
        returnId: returned.id,
        returnType: "sales_return",
        reason: "Refund voided",
      }, "Owner");
      expect(reversed.reversedAt).toBeTruthy();
      expect(service.get(fabric.id).fabric.stockMm).toBe(100_000);
      expect(service.listInvoices()[0]).toEqual(originalInvoice);
      expect(returns.data().auditLog.slice(0, 2).map((entry) => entry.action)).toEqual([
        "sales_return_reversal",
        "sales_return",
      ]);
      expect(returns.data().auditLog.every((entry) => !entry.reason.includes("123456"))).toBe(true);
      expect(() => database.prepare("UPDATE audit_log SET reason = 'Edited' WHERE id = ?")
        .run(returns.data().auditLog[0].id)).toThrow(/Audit log records are immutable/);
      expect(() => database.prepare("UPDATE sales_returns SET total_minor = 1 WHERE id = ?")
        .run(returned.id)).toThrow(/Sales return records are immutable/);
      expect(accounting.trialBalance("2026-10-27").isBalanced).toBe(true);
    } finally {
      close();
      vi.useRealTimers();
    }
  });

  it("posts supplier debit notes for purchase returns and supports an audited reversal", async () => {
    const { service, suppliers, returns, accounting, close } = await createService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      const supplier = suppliers.create({
        code: "SUP-RETURN",
        name: "Return Supplier",
        phone: "",
        address: "",
        contactName: "",
        email: "",
        openingBalance: 0,
      }, "System");
      const purchase = suppliers.receive(supplierPurchaseSchema.parse({
        supplierId: supplier.id,
        billNumber: "RETURN-PURCHASE",
        purchaseDate: "2026-10-27",
        additionalCosts: 0,
        paymentMode: "credit",
        amountPaid: 0,
        items: [{ fabricId: fabric.id, quantityMeters: 20, unitCost: 145 }],
      }));
      const purchaseSource = returns.data().purchases.find((source) => source.billNumber === "RETURN-PURCHASE");
      expect(purchaseSource?.items[0].remainingQuantityMm).toBe(20_000);
      const returned = returns.createPurchase({
        purchaseId: purchase.purchases[0].id,
        settlementType: "supplier_credit",
        reason: "Five meters rejected",
        items: [{ sourceItemId: purchaseSource!.items[0].sourceItemId, quantityMeters: 5 }],
      }, "Owner");
      expect(returned).toMatchObject({
        returnType: "purchase_return",
        sourceReference: "RETURN-PURCHASE",
        totalMinor: 72_500,
      });
      expect(service.get(fabric.id).fabric.stockMm).toBe(15_000);
      expect(returns.data().purchases[0].items[0].remainingQuantityMm).toBe(15_000);
      expect(() => returns.createPurchase({
        purchaseId: purchase.purchases[0].id,
        settlementType: "supplier_credit",
        reason: "Too many",
        items: [{ sourceItemId: purchaseSource!.items[0].sourceItemId, quantityMeters: 16 }],
      }, "Owner")).toThrowError(/eligible remaining quantity/);
      expect(() => returns.createPurchase({
        purchaseId: purchase.purchases[0].id,
        settlementType: "supplier_credit",
        reason: "Duplicate line attempt",
        items: [
          { sourceItemId: purchaseSource!.items[0].sourceItemId, quantityMeters: 7 },
          { sourceItemId: purchaseSource!.items[0].sourceItemId, quantityMeters: 7 },
        ],
      }, "Owner")).toThrowError(/Each purchase line may appear only once/);
      expect(service.get(fabric.id).fabric.stockMm).toBe(15_000);
      expect(suppliers.reconcile().differenceMinor).toBe(0);
      expect(accounting.trialBalance("2026-10-27").isBalanced).toBe(true);

      returns.reverse({
        returnId: returned.id,
        returnType: "purchase_return",
        reason: "Supplier accepted goods",
      }, "Owner");
      expect(service.get(fabric.id).fabric.stockMm).toBe(20_000);
      expect(returns.data().purchases[0].items[0].remainingQuantityMm).toBe(20_000);
      expect(returns.data().auditLog.slice(0, 2).map((entry) => entry.action)).toEqual([
        "purchase_return_reversal",
        "purchase_return",
      ]);
      expect(accounting.trialBalance("2026-10-27").isBalanced).toBe(true);
    } finally {
      close();
      vi.useRealTimers();
    }
  });

  it("applies a customer credit note to the source invoice and advances only the excess", async () => {
    const { service, inventory, customers, returns, accounting, close } = await createService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      inventory.openStock({
        fabricId: fabric.id,
        quantityMeters: 30,
        unitCost: 145,
        reference: "RETURNS-CREDIT-STOCK",
        reason: "Customer credit return test",
      }, "Owner");
      const customer = customers.create({
        code: "CUS-CREDIT-RETURN",
        name: "Credit Note Customer",
        phone: "",
        address: "",
        openingBalance: 0,
        creditLimit: 10_000,
        paymentTermsDays: 0,
      }, "System");
      const invoice = service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 20, unitRate: 180 }],
        receivedAmount: 1_000,
      }));
      const sourceItemId = invoice.items[0].id;
      expect(() => returns.createSales({
        invoiceId: invoice.id,
        settlementType: "refund",
        paymentAccountCode: "1000",
        reason: "Attempted refund of unpaid sale",
        items: [{ sourceItemId, quantityMeters: 20, saleable: false }],
      }, "Owner")).toThrowError(/Refund exceeds the amount received/);
      expect(service.get(fabric.id).fabric.stockMm).toBe(10_000);
      const creditNote = returns.createSales({
        invoiceId: invoice.id,
        settlementType: "customer_credit",
        reason: "Full order returned as unsaleable",
        items: [{ sourceItemId, quantityMeters: 20, saleable: false }],
      }, "Owner");

      expect(creditNote.totalMinor).toBe(invoice.totalMinor);
      expect(service.listInvoices()[0]).toMatchObject({
        totalMinor: invoice.totalMinor,
        amountReceivedMinor: invoice.amountReceivedMinor,
        dueMinor: 0,
      });
      expect(customers.get(customer.id).sales[0].dueMinor).toBe(0);
      expect(customers.get(customer.id).customer).toMatchObject({
        outstandingMinor: 0,
        advanceMinor: 100_000,
      });

      expect(service.get(fabric.id).fabric.stockMm).toBe(10_000);
      expect(accounting.trialBalance("2026-10-27").isBalanced).toBe(true);

      returns.reverse({
        returnId: creditNote.id,
        returnType: "sales_return",
        reason: "Credit note entered in error",
      }, "Owner");
      expect(service.listInvoices()[0].dueMinor).toBe(invoice.totalMinor - invoice.amountReceivedMinor);
      expect(customers.get(customer.id).customer).toMatchObject({
        outstandingMinor: invoice.totalMinor - invoice.amountReceivedMinor,
        advanceMinor: 0,
      });
      expect(accounting.trialBalance("2026-10-27").isBalanced).toBe(true);
    } finally {
      close();
      vi.useRealTimers();
    }
  });

  it("keeps receivables and invoice due unchanged for refunded sales", async () => {
    const { service, inventory, customers, returns, reports, close } = await createService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      inventory.openStock({
        fabricId: fabric.id,
        quantityMeters: 20,
        unitCost: 145,
        reference: "RETURNS-REFUND-STOCK",
        reason: "Refund receivable test",
      }, "Owner");
      const customer = customers.create({
        code: "CUS-REFUND-AR",
        name: "Refund AR Customer",
        phone: "",
        address: "",
        openingBalance: 0,
        creditLimit: 10_000,
        paymentTermsDays: 0,
      }, "System");
      const invoice = service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 20, unitRate: 180 }],
        receivedAmount: 1_800,
      }));
      const saleReturn = returns.createSales({
        invoiceId: invoice.id,
        settlementType: "refund",
        paymentAccountCode: "1000",
        reason: "Refund paid portion",
        items: [{ sourceItemId: invoice.items[0].id, quantityMeters: 10, saleable: false }],
      }, "Owner");
      expect(saleReturn.totalMinor).toBe(invoice.amountReceivedMinor);
      expect(service.listInvoices()[0].dueMinor).toBe(180_000);
      expect(customers.get(customer.id).sales[0].dueMinor).toBe(180_000);
      expect(customers.get(customer.id).customer.outstandingMinor).toBe(180_000);

      const balances = reports.run({
        reportType: "customer_balances",
        from: "2026-10-28",
        to: "2026-10-28",
        search: "",
        page: 1,
        pageSize: 25,
      });
      expect(balances.rows.find((row) => row.code === customer.code)).toMatchObject({
        balance_minor: 180_000,
        overdue_minor: 180_000,
      });

      expect(() => customers.receive(customerReceiptSchema.parse({
        customerId: customer.id,
        invoiceId: invoice.id,
        amount: 1_801,
        account: "cash",
        reference: "",
        note: "",
      }))).toThrowError(/remaining amount due/);
      expect(service.listInvoices()[0].dueMinor).toBe(180_000);

      returns.reverse({
        returnId: saleReturn.id,
        returnType: "sales_return",
        reason: "Refund voided",
      }, "Owner");
      expect(service.listInvoices()[0].dueMinor).toBe(180_000);
      expect(customers.get(customer.id).customer.outstandingMinor).toBe(180_000);
    } finally {
      close();
      vi.useRealTimers();
    }
  });

  it("requires owner PINs for accounting write contracts", () => {
    const journalLines = [
      { accountCode: "1000", debitMinor: 100 },
      { accountCode: "3000", creditMinor: 100 },
    ];
    expect(accountingManualEntrySchema.safeParse({
      sourceId: "owner-pin-test",
      reference: "OWNER-PIN-TEST",
      date: "2026-10-27",
      lines: journalLines,
    }).success).toBe(false);
    expect(accountingOpeningBalancesSchema.safeParse({
      sourceId: "owner-pin-test",
      date: "2026-10-27",
      lines: journalLines,
    }).success).toBe(false);
    expect(accountingEntryReversalSchema.safeParse({
      id: "00000000-0000-4000-8000-000000000001",
      reason: "Correction",
    }).success).toBe(false);
    expect(accountingClosePeriodSchema.safeParse({ id: "2026-10" }).success).toBe(false);
    expect(accountingClosePeriodSchema.safeParse({ id: "2026-10", ownerPin: "123456" }).success).toBe(true);
  });

  it("requires owner authorization for backup export, configuration, verification, and restore", () => {
    expect(backupAuthorizationSchema.safeParse({}).success).toBe(false);
    expect(backupAuthorizationSchema.safeParse({ ownerPin: "not-numeric" }).success).toBe(false);
    expect(backupAuthorizationSchema.safeParse({ ownerPin: "123456" }).success).toBe(true);
    expect(backupScheduleSchema.safeParse({ frequency: "daily" }).success).toBe(false);
    expect(backupScheduleSchema.safeParse({ frequency: "daily", ownerPin: "123456" }).success).toBe(true);
  });

  it("accepts supported document paper formats and rejects unsupported formats", () => {
    expect(printDocumentSchema.parse({ paperFormat: "A4" })).toEqual({ paperFormat: "A4" });
    expect(printDocumentSchema.safeParse({ paperFormat: "A3" }).success).toBe(false);
  });

  it("balances purchases, sales, receipts and expenses in accounting reports", async () => {
    const { database, service, inventory, suppliers, customers, accounting, close } = await createService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      const openingEntry = accounting.postOpeningBalances({
        sourceId: "opening-ledger-2026",
        date: "2026-10-27",
        lines: [
          { accountCode: "1000", debitMinor: 100_000 },
          { accountCode: "3000", creditMinor: 100_000 },
        ],
      });
      expect(openingEntry?.transactionType).toBe("opening_balance");
      const supplier = suppliers.create({
        code: "SUP-LEDGER",
        name: "Ledger Supplier",
        phone: "03000000000",
        address: "",
        contactName: "",
        email: "",
        openingBalance: 0,
      }, "System");
      suppliers.receive(supplierPurchaseSchema.parse({
        supplierId: supplier.id,
        billNumber: "LEDGER-BILL-1",
        purchaseDate: "2026-10-27",
        additionalCosts: 0,
        paymentMode: "credit",
        amountPaid: 0,
        items: [{ fabricId: fabric.id, quantityMeters: 20, unitCost: 145 }],
      }));
      const customer = customers.create({
        code: "CUS-LEDGER",
        name: "Ledger Customer",
        phone: "",
        address: "",
        openingBalance: 0,
        creditLimit: 1000,
        paymentTermsDays: 30,
      }, "System");
      const invoice = service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 5, unitRate: 200 }],
        receivedAmount: 0,
      }));
      customers.receive(customerReceiptSchema.parse({
        customerId: customer.id,
        invoiceId: invoice.id,
        amount: 500,
        account: "cash",
      }));

      const expenseAccount = accounting.createAccount({
        code: "5800",
        name: "Office Expenses",
        accountType: "expense",
        isPaymentAccount: false,
      });
      expect(expenseAccount.normalBalance).toBe("debit");
      const expense = accounting.postEntry({
        sourceId: "expense-ledger-1",
        reference: "EXP-LEDGER-1",
        date: "2026-10-27",
        lines: [
          { accountCode: "5800", debitMinor: 10_000 },
          { accountCode: "1000", creditMinor: 10_000 },
        ],
      });
      expect(expense?.lines).toHaveLength(2);
      expect(accounting.trialBalance("2026-10-26").lines.find((line) => line.accountCode === "5800"))
        .toMatchObject({ debitMinor: 0, creditMinor: 0 });
      expect(() => accounting.postEntry({
        sourceId: "expense-ledger-1",
        reference: "EXP-LEDGER-1",
        date: "2026-10-27",
        lines: [
          { accountCode: "5800", debitMinor: 10_000 },
          { accountCode: "1000", creditMinor: 10_000 },
        ],
      })).toThrow();
      expect(() => accounting.postEntry({
        sourceId: "unlinked-receivable",
        reference: "NO-CUSTOMER",
        date: "2026-10-27",
        lines: [
          { accountCode: "1300", debitMinor: 100 },
          { accountCode: "1000", creditMinor: 100 },
        ],
      })).toThrow(/require a customer/);
      expect(() => accounting.postEntry({
        sourceId: "unlinked-advance",
        reference: "NO-ADVANCE-CUSTOMER",
        date: "2026-10-27",
        lines: [
          { accountCode: "2200", creditMinor: 100 },
          { accountCode: "1000", debitMinor: 100 },
        ],
      })).toThrow(/require a customer/);
      expect(() => accounting.postOpeningBalances({
        sourceId: "unlinked-payable",
        date: "2026-10-27",
        lines: [
          { accountCode: "2100", creditMinor: 100 },
          { accountCode: "3000", debitMinor: 100 },
        ],
      })).toThrow(/require a supplier/);

      const trialBalance = accounting.trialBalance("2026-10-27");
      expect(trialBalance.isBalanced).toBe(true);
      expect(trialBalance.totalDebitsMinor).toBe(trialBalance.totalCreditsMinor);
      expect(accounting.generalLedger({
        accountCode: "5800",
        from: "2026-10-27",
        to: "2026-10-27",
      }).closingBalanceMinor).toBe(10_000);
      expect(accounting.reconcile()).toMatchObject({
        isBalanced: true,
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "Accounts receivable subledger", isBalanced: true }),
          expect.objectContaining({ name: "Accounts payable subledger", isBalanced: true }),
          expect.objectContaining({ name: "Inventory valuation", isBalanced: true }),
        ]),
      });

      const expenseEntry = expense!;
      expect(() => database.prepare("UPDATE ledger_transactions SET reference = 'changed' WHERE id = ?")
        .run(expenseEntry.id)).toThrow(/immutable/);
      expect(() => database.prepare("DELETE FROM ledger_postings WHERE transaction_id = ?")
        .run(expenseEntry.id)).toThrow(/immutable/);
      const reversal = accounting.reverseEntry(expenseEntry.id, "Incorrect expense entry");
      expect(reversal).toMatchObject({
        transactionType: "reversal",
        reference: "EXP-LEDGER-1",
        reversalOfTransactionId: expenseEntry.id,
        reversalReason: "Incorrect expense entry",
      });
      expect(accounting.getEntry(expenseEntry.id).reversedByTransactionId).toBe(reversal.id);
      expect(() => accounting.reverseEntry(expenseEntry.id, "Duplicate reversal")).toThrow();
      const sourceSale = accounting.listEntries().find((entry) => entry.transactionType === "sale");
      expect(sourceSale).toBeDefined();
      expect(() => accounting.reverseEntry(sourceSale!.id, "Try direct sale reversal"))
        .toThrow(/source transaction through its domain service/);
      expect(accounting.trialBalance("2026-10-27").isBalanced).toBe(true);

      const period = accounting.listPeriods().find((item) => item.startsOn <= "2026-10-27" && item.endsOn >= "2026-10-27");
      expect(period?.status).toBe("open");
      accounting.postEntry({
        sourceId: "september-journal",
        reference: "SEP-ENTRY",
        date: "2026-09-10",
        lines: [
          { accountCode: "5800", debitMinor: 100 },
          { accountCode: "1000", creditMinor: 100 },
        ],
      });
      expect(() => accounting.closePeriod(period!.id)).toThrow(/earlier open accounting periods/);
      accounting.closePeriod("2026-09");
      accounting.closePeriod(period!.id);
      const invoicesBeforeClosedPeriodSale = service.listInvoices().length;
      const stockBeforeClosedPeriodSale = service.get(fabric.id).fabric.stockMm;
      const movementsBeforeClosedPeriodSale = inventory.movements().length;
      expect(() => service.createInvoice(createInvoiceSchema.parse({
        items: [{ fabricId: fabric.id, quantityMeters: 1 }],
      }))).toThrow(/closed/);
      expect(service.listInvoices()).toHaveLength(invoicesBeforeClosedPeriodSale);
      expect(service.get(fabric.id).fabric.stockMm).toBe(stockBeforeClosedPeriodSale);
      expect(inventory.movements()).toHaveLength(movementsBeforeClosedPeriodSale);
      expect(() => accounting.postEntry({
        sourceId: "expense-closed-period",
        reference: "EXP-CLOSED",
        date: "2026-10-27",
        lines: [
          { accountCode: "5800", debitMinor: 100 },
          { accountCode: "1000", creditMinor: 100 },
        ],
      })).toThrow(/closed/);
      expect(() => accounting.postEntry({
        sourceId: "before-latest-closed",
        reference: "BEFORE-CLOSED",
        date: "2026-09-01",
        lines: [
          { accountCode: "5800", debitMinor: 100 },
          { accountCode: "1000", creditMinor: 100 },
        ],
      })).toThrow(/on or before the latest closed/);
      expect(() => accounting.postEntry({
        sourceId: "duplicate-accounting-code",
        reference: "DUP-ACCOUNT",
        date: "2026-11-01",
        lines: [
          { accountCode: "5800", debitMinor: 100 },
          { accountCode: "1000", creditMinor: 100 },
        ],
      })).not.toThrow();
      expect(() => accounting.createAccount({
        code: "5800",
        name: "Duplicate account",
        accountType: "expense",
        isPaymentAccount: false,
      })).toThrowError(new FabricServiceError(
        "CONFLICT",
        "A ledger account with this code already exists.",
      ));
    } finally {
      vi.useRealTimers();
      close();
    }
  });

  it("records a PKR 2,000 cash expense with matching cash and expense ledger balances", async () => {
    const { database, accounting, expenses, close } = await createService();
    try {
      accounting.postOpeningBalances({
        sourceId: "cash-opening-expense-acceptance",
        date: "2026-10-27",
        lines: [
          { accountCode: "1000", debitMinor: 1_000_000 },
          { accountCode: "3000", creditMinor: 1_000_000 },
        ],
      });

      const expense = expenses.record({
        categoryCode: "rent",
        paymentAccountCode: "1000",
        amount: 2_000,
        expenseDate: "2026-10-27",
        description: "Shop rent",
      });
      expect(expense).toMatchObject({
        categoryName: "Rent",
        paymentAccountName: "Cash",
        amountMinor: 200_000,
        expenseDate: "2026-10-27",
      });
      const cashbook = accounting.generalLedger({
        accountCode: "1000",
        from: "2026-10-27",
        to: "2026-10-27",
      });
      const rentLedger = accounting.generalLedger({
        accountCode: "5200",
        from: "2026-10-27",
        to: "2026-10-27",
      });
      expect(cashbook.closingBalanceMinor).toBe(800_000);
      expect(cashbook.lines.at(-1)).toMatchObject({ creditMinor: 200_000 });
      expect(rentLedger.closingBalanceMinor).toBe(200_000);
      expect(rentLedger.lines.at(-1)).toMatchObject({ debitMinor: 200_000 });
      expect(expenses.list({ from: "2026-10-27", to: "2026-10-27" })).toHaveLength(1);
      expect(expenses.report({ from: "2026-10-27", to: "2026-10-27" })).toMatchObject({
        totalMinor: 200_000,
        categories: expect.arrayContaining([expect.objectContaining({
          categoryCode: "rent",
          amountMinor: 200_000,
          expenseCount: 1,
        })]),
      });
      const originalExpenseTransaction = database.prepare(
        "SELECT id FROM ledger_transactions WHERE source_key = ?",
      ).get(`expense:${expense.id}`) as { id: string };
      database.prepare(`
        INSERT INTO ledger_transactions (
          id, transaction_type, reference, authorized_user, created_at,
          source_key, reversal_of_transaction_id, reversal_reason, period_id
        ) VALUES (
          'expense-reversal', 'reversal', ?, 'Test', '2026-10-28T12:00:00.000Z',
          ?, ?, 'Test reversal', '2026-10'
        )
      `).run(
        expense.expenseNumber,
        `reversal:${expense.id}`,
        originalExpenseTransaction.id,
      );
      database.prepare(`
        INSERT INTO ledger_postings (
          id, transaction_id, account_code, debit_minor, credit_minor
        ) VALUES
          ('expense-reversal-expense', 'expense-reversal', '5200', 0, 200000),
          ('expense-reversal-cash', 'expense-reversal', '1000', 200000, 0)
      `).run();
      expect(expenses.list({ from: "2026-10-27", to: "2026-10-27" })[0].isReversed).toBe(true);
      expect(expenses.report({ from: "2026-10-27", to: "2026-10-27" }).totalMinor).toBe(200_000);
      expect(expenses.report({ from: "2026-10-27", to: "2026-10-28" }).totalMinor).toBe(0);
      expect(() => expenses.record({
        categoryCode: "rent",
        paymentAccountCode: "1300",
        amount: 10,
        expenseDate: "2026-10-27",
        description: "Receivable is not a payment account",
      })).toThrow(/configured cash or payment account/);
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM ledger_transactions
        WHERE transaction_type = 'expense' AND source_key = ?
      `).get(`expense:${expense.id}`)).toMatchObject({ count: 1 });
      expect(accounting.trialBalance("2026-10-27").isBalanced).toBe(true);

      const category = expenses.addCategory({ code: "repairs", name: "Repairs and maintenance" });
      expect(category).toMatchObject({ code: "repairs", name: "Repairs and maintenance" });
      expect(accounting.listAccounts().find((account) => account.code === category.accountCode))
        .toMatchObject({ accountType: "expense", normalBalance: "debit" });

      const savedCount = expenses.list({ from: "2026-10-27", to: "2026-10-27" }).length;
      accounting.closePeriod("2026-10");
      expect(() => expenses.record({
        categoryCode: "rent",
        paymentAccountCode: "1000",
        amount: 25,
        expenseDate: "2026-10-27",
        description: "Expense in a closed period",
      })).toThrow(/closed/);
      expect(expenses.list({ from: "2026-10-27", to: "2026-10-27" })).toHaveLength(savedCount);
      expect(accounting.trialBalance("2026-10-27").isBalanced).toBe(true);
    } finally {
      close();
    }
  });

  it("reconciles analytics stock and customer balances to control accounts", async () => {
    const { service, inventory, customers, suppliers, reports, close } = await createService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      inventory.openStock({
        fabricId: fabric.id,
        quantityMeters: 5,
        unitCost: 100,
        reference: "REPORT-OPENING-STOCK",
        reason: "Analytics report test",
      }, "Owner");
      const customer = customers.create({
        code: "CUS-REPORT",
        name: "Analytics Customer",
        phone: "",
        address: "",
        openingBalance: 0,
        creditLimit: 1000,
        paymentTermsDays: 0,
      }, "System");
      const supplier = suppliers.create({
        code: "SUP-REPORT",
        name: "Analytics Supplier",
        phone: "03000000000",
        address: "",
        contactName: "",
        email: "",
        openingBalance: 0,
      }, "System");
      suppliers.receive(supplierPurchaseSchema.parse({
        supplierId: supplier.id,
        billNumber: "REPORT-PURCHASE-1",
        purchaseDate: "2026-10-27",
        additionalCosts: 0,
        paymentMode: "credit",
        amountPaid: 0,
        items: [{ fabricId: fabric.id, quantityMeters: 1, unitCost: 100 }],
      }));
      const invoice = service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 2, unitRate: 200 }],
        discount: 5,
        receivedAmount: 100,
      }));

      const dailySales = reports.run({
        reportType: "daily_sales",
        from: "2026-10-27",
        to: "2026-10-27",
        search: invoice.invoiceNumber,
        page: 1,
        pageSize: 1,
      });
      expect(dailySales).toMatchObject({
        totalRows: 1,
        totals: { grossSalesMinor: 40_000, returnsMinor: 0, netSalesMinor: 39_500 },
      });
      expect(dailySales.rows[0]).toMatchObject({
        invoice: invoice.invoiceNumber,
        gross_minor: 40_000,
        discount_minor: 500,
        net_minor: 39_500,
      });

      const stock = reports.run({
        reportType: "stock_summary",
        from: "2026-10-26",
        to: "2026-10-26",
        search: "",
        page: 1,
        pageSize: 25,
      });
      expect(stock).toMatchObject({
        from: "2026-10-26",
        to: "2026-10-26",
        reconciliations: [{ isBalanced: true, differenceMinor: 0 }],
      });
      const customerBalances = reports.run({
        reportType: "customer_balances",
        from: "2026-10-27",
        to: "2026-10-27",
        search: "",
        page: 1,
        pageSize: 25,
      });
      expect(customerBalances.reconciliations[0]).toMatchObject({ isBalanced: true, differenceMinor: 0 });
      expect(customerBalances.rows.find((row) => row.code === customer.code)?.balance_minor)
        .toBe(invoice.dueMinor);
      const supplierBalances = reports.run({
        reportType: "supplier_balances",
        from: "2026-10-27",
        to: "2026-10-27",
        search: supplier.code,
        page: 1,
        pageSize: 25,
      });
      expect(supplierBalances.reconciliations[0]).toMatchObject({ isBalanced: true, differenceMinor: 0 });
      expect(supplierBalances.rows[0].balance_minor).toBe(10_000);
      expect(reports.run({
        reportType: "purchases",
        from: "2026-10-27",
        to: "2026-10-27",
        search: "REPORT-PURCHASE-1",
        page: 1,
        pageSize: 25,
      }).totals).toMatchObject({ quantityMeters: 1, purchaseCostMinor: 10_000 });
      expect(reports.run({
        reportType: "gross_profit",
        from: "2026-10-27",
        to: "2026-10-27",
        search: "",
        page: 1,
        pageSize: 25,
      }).totals).toMatchObject({ revenueMinor: 39_500, costOfGoodsSoldMinor: 20_000, grossProfitMinor: 19_500 });
      expect(reports.run({
        reportType: "profit_loss",
        from: "2026-10-27",
        to: "2026-10-27",
        search: "",
        page: 1,
        pageSize: 25,
      }).totals.netProfitMinor).toBe(19_500);
      expect(reports.run({
        reportType: "cashbook",
        from: "2026-10-27",
        to: "2026-10-27",
        search: "",
        page: 1,
        pageSize: 25,
      }).columns.map((column) => column.key)).toContain("balance_minor");
      expect(reports.run({
        reportType: "general_ledger",
        from: "2026-10-27",
        to: "2026-10-27",
        search: "",
        accountCode: "1200",
        page: 1,
        pageSize: 25,
      }).rows.length).toBeGreaterThan(0);
      const trialBalance = reports.run({
        reportType: "trial_balance",
        from: "2026-10-27",
        to: "2026-10-27",
        search: "",
        page: 1,
        pageSize: 25,
      });
      expect(trialBalance.totals.debitMinor).toBe(trialBalance.totals.creditMinor);
      const paged = reports.run({
        reportType: "daily_sales",
        from: "2026-10-27",
        to: "2026-10-27",
        search: "",
        page: 2,
        pageSize: 1,
      });
      expect(paged.rows).toHaveLength(0);
      expect(paged.totalRows).toBe(1);
    } finally {
      vi.useRealTimers();
      close();
    }
  });

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
      expect(historicalInvoice).toMatchObject({
        subtotalMinor: 45000,
        discountMinor: 0,
        totalMinor: 45000,
        amountReceivedMinor: 0,
        dueMinor: 45000,
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
      const otherCustomer = customers.create({
        code: "CUS-002",
        name: "Second Buyer",
        phone: "",
        address: "",
        openingBalance: 0,
        creditLimit: 0,
        paymentTermsDays: 0,
      }, "System");
      expect(() => customers.update({
        id: customer.id,
        code: otherCustomer.code,
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        creditLimit: customerInput.creditLimit,
        paymentTermsDays: customerInput.paymentTermsDays,
      })).toThrowError(new FabricServiceError("CONFLICT", "That customer code is already in use."));
      expect(customers.get(customer.id).customer.code).toBe("CUS-001");

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
        invoiceId: invoice.id,
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

  it("posts a discounted credit sale once across inventory, receivables, revenue and COGS", async () => {
    const { database, service, inventory, customers, close } = await createService();
    try {
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      inventory.openStock({
        fabricId: fabric.id,
        quantityMeters: 20,
        unitCost: 145,
        reference: "POS-ACCEPTANCE-STOCK",
        reason: "POS acceptance stock",
      }, "Owner");
      const customerInput = customerInputSchema.parse({
        code: "CUS-POS",
        name: "POS Wholesale Buyer",
        phone: "0300-1112233",
        address: "10 Market Road",
        openingBalance: 0,
        creditLimit: 1000,
        paymentTermsDays: 30,
      });
      const customer = customers.create({
        code: customerInput.code,
        name: customerInput.name,
        phone: customerInput.phone,
        address: customerInput.address,
        openingBalance: customerInput.openingBalance,
        creditLimit: customerInput.creditLimit,
        paymentTermsDays: customerInput.paymentTermsDays,
      }, "System");

      const invoice = service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 5.5, unitRate: 200 }],
        discount: 100,
        receivedAmount: 400,
        paymentAccount: "cash",
      }));
      expect(invoice).toMatchObject({
        customerPhone: "0300-1112233",
        customerAddress: "10 Market Road",
        paymentTermsDays: 30,
      });
      expect(invoice).toMatchObject({
        subtotalMinor: 110_000,
        discountMinor: 10_000,
        totalMinor: 100_000,
        amountReceivedMinor: 40_000,
        dueMinor: 60_000,
      });
      expect(invoice.items[0]).toMatchObject({
        quantityMm: 5_500,
        unitPriceMinor: 20_000,
        lineTotalMinor: 110_000,
      });
      expect(service.get(fabric.id).fabric.stockMm).toBe(14_500);
      expect(customers.get(customer.id).customer.outstandingMinor).toBe(60_000);
      expect(inventory.movements().filter((movement) => movement.movementType === "sale"))
        .toHaveLength(1);

      const saleTransaction = database.prepare(`
        SELECT id FROM ledger_transactions WHERE transaction_type = 'sale' AND reference = ?
      `).get(invoice.invoiceNumber) as { id: string };
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM ledger_transactions
        WHERE transaction_type = 'sale' AND reference = ?
      `).get(invoice.invoiceNumber)).toMatchObject({ count: 1 });
      const postings = database.prepare(`
        SELECT account_code, SUM(debit_minor) AS debit, SUM(credit_minor) AS credit
        FROM ledger_postings WHERE transaction_id = ? GROUP BY account_code ORDER BY account_code
      `).all(saleTransaction.id) as Array<{ account_code: string; debit: number; credit: number }>;
      expect(postings).toEqual([
        { account_code: "1000", debit: 40_000, credit: 0 },
        { account_code: "1200", debit: 0, credit: 79_750 },
        { account_code: "1300", debit: 60_000, credit: 0 },
        { account_code: "4000", debit: 0, credit: 100_000 },
        { account_code: "5000", debit: 79_750, credit: 0 },
      ]);
      expect(service.listInvoices()[0]).toMatchObject({
        id: invoice.id,
        discountMinor: 10_000,
        amountReceivedMinor: 40_000,
        dueMinor: 60_000,
        customerPhone: "0300-1112233",
        customerAddress: "10 Market Road",
        paymentTermsDays: 30,
      });
      database.prepare(`
        UPDATE customers SET phone = ?, address = ?, payment_terms_days = ? WHERE id = ?
      `).run("0300-9998877", "Updated address", 90, customer.id);
      expect(service.listInvoices()[0]).toMatchObject({
        customerPhone: "0300-1112233",
        customerAddress: "10 Market Road",
        paymentTermsDays: 30,
      });
      expect(service.get(fabric.id).invoices[0]).toMatchObject({
        customerPhone: "0300-1112233",
        customerAddress: "10 Market Road",
        paymentTermsDays: 30,
      });
      expect(customers.get(customer.id).sales[0]).toMatchObject({
        customerPhone: "0300-1112233",
        customerAddress: "10 Market Road",
        paymentTermsDays: 30,
      });

      const movementCount = inventory.movements().length;
      const invoiceCount = service.listInvoices().length;
      expect(() => service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 1 }],
        receivedAmount: 10_000,
      }))).toThrowError(new FabricServiceError("VALIDATION", "The received amount cannot exceed the invoice total."));
      expect(inventory.movements()).toHaveLength(movementCount);
      expect(service.listInvoices()).toHaveLength(invoiceCount);
      expect(customers.get(customer.id).customer.outstandingMinor).toBe(60_000);
    } finally {
      close();
    }
  });

  it("persists invoice receipt allocations and customer balances across a database restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "greige-receipt-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "pos.sqlite");
    let database = await openDatabase(databasePath, migrationsDirectory);
    try {
      let service = new FabricService(database);
      const inventory = new InventoryService(database);
      let customers = new CustomerService(database);
      const fabric = service.create(fabricInputSchema.parse(sampleFabric));
      inventory.openStock({
        fabricId: fabric.id,
        quantityMeters: 100,
        unitCost: 145,
        reference: "RECEIPT-RESTART-STOCK",
        reason: "Receipt restart test stock",
      }, "Owner");
      const customer = customers.create({
        code: "CUS-RESTART",
        name: "Restart Receipt Customer",
        phone: "",
        address: "",
        openingBalance: 0,
        creditLimit: 100_000,
        paymentTermsDays: 30,
      }, "System");
      const invoice = service.createInvoice(createInvoiceSchema.parse({
        customerId: customer.id,
        items: [{ fabricId: fabric.id, quantityMeters: 100 }],
      }));
      const receipt = customers.receive(customerReceiptSchema.parse({
        customerId: customer.id,
        invoiceId: invoice.id,
        amount: 5_000,
        accountCode: "1010",
        reference: "BANK-5000",
        note: "Invoice installment",
      }));
      expect(receipt.customer.outstandingMinor).toBe(invoice.totalMinor - 500_000);
      expect(receipt.sales[0].dueMinor).toBe(invoice.totalMinor - 500_000);
      expect(receipt.receipts[0]).toMatchObject({
        invoiceId: invoice.id,
        paymentMethod: "Bank",
        amountMinor: 500_000,
      });

      database.close();
      database = await openDatabase(databasePath, migrationsDirectory);
      service = new FabricService(database);
      customers = new CustomerService(database);
      const reopened = customers.get(customer.id);
      expect(reopened.customer.outstandingMinor).toBe(invoice.totalMinor - 500_000);
      expect(reopened.sales[0].dueMinor).toBe(invoice.totalMinor - 500_000);
      expect(reopened.receipts).toHaveLength(1);
      expect(reopened.receipts[0]).toMatchObject({
        receiptNumber: receipt.receipts[0].receiptNumber,
        amountMinor: 500_000,
        invoiceNumber: invoice.invoiceNumber,
      });

      const reversed = customers.reverseReceipt({
        receiptId: reopened.receipts[0].id,
        reason: "Duplicate bank confirmation",
      });
      expect(reversed.customer.outstandingMinor).toBe(invoice.totalMinor);
      expect(reversed.sales[0].dueMinor).toBe(invoice.totalMinor);
      expect(reversed.receipts[0].reversedAt).toBeTruthy();
      expect(() => customers.reverseReceipt({
        receiptId: reopened.receipts[0].id,
        reason: "Duplicate reversal",
      })).toThrowError(new FabricServiceError("CONFLICT", "This customer receipt has already been reversed."));
      expect(service.listInvoices()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("records advances separately from receivables and reverses supplier vouchers atomically", async () => {
    const { database, suppliers, customers, close } = await createService();
    try {
      database.prepare(`
        INSERT INTO ledger_accounts (code, name, account_type)
        VALUES ('1020', 'Mobile Wallet', 'asset')
      `).run();
      const accounts = customers.paymentAccounts();
      expect(accounts).not.toContainEqual({ code: "1020", name: "Mobile Wallet" });
      database.prepare("UPDATE ledger_accounts SET is_payment_account = 1 WHERE code = '1020'").run();
      expect(customers.paymentAccounts()).toContainEqual({ code: "1020", name: "Mobile Wallet" });

      const customer = customers.create({
        code: "CUS-ADVANCE",
        name: "Advance Customer",
        phone: "",
        address: "",
        openingBalance: 2_000,
        creditLimit: 0,
        paymentTermsDays: 0,
      }, "Owner");
      const partialReceipt = customers.receive(customerReceiptSchema.parse({
        customerId: customer.id,
        amount: 1_500,
        accountCode: "1020",
        reference: "PARTIAL-SETTLEMENT",
      }));
      expect(partialReceipt.customer.outstandingMinor).toBe(50_000);
      expect(partialReceipt.customer.advanceMinor).toBe(0);
      expect(partialReceipt.receipts[0]).toMatchObject({
        receivableMinor: 150_000,
        advanceMinor: 0,
      });

      const splitReceipt = customers.receive(customerReceiptSchema.parse({
        customerId: customer.id,
        amount: 1_000,
        accountCode: "1020",
        reference: "SPLIT-SETTLEMENT",
      }));
      expect(splitReceipt.customer.outstandingMinor).toBe(0);
      expect(splitReceipt.customer.advanceMinor).toBe(50_000);
      expect(splitReceipt.receipts[0]).toMatchObject({
        receivableMinor: 50_000,
        advanceMinor: 50_000,
      });
      const reversedSplit = customers.reverseReceipt({
        receiptId: splitReceipt.receipts[0].id,
        reason: "Reverse split receipt",
      });
      expect(reversedSplit.customer.outstandingMinor).toBe(50_000);
      expect(reversedSplit.customer.advanceMinor).toBe(0);
      const reversedPartial = customers.reverseReceipt({
        receiptId: partialReceipt.receipts[0].id,
        reason: "Reverse partial receipt",
      });
      expect(reversedPartial.customer.outstandingMinor).toBe(200_000);

      const supplier = suppliers.create({
        code: "SUP-REVERSE",
        name: "Voucher Supplier",
        phone: "",
        address: "",
        contactName: "",
        email: "",
        openingBalance: 10_000,
      }, "System");
      const paymentDetails = suppliers.pay({
        supplierId: supplier.id,
        amount: 2_500,
        accountCode: "1020",
        reference: "WALLET-PAY",
        note: "Partial settlement",
      });
      expect(paymentDetails.supplier.outstandingMinor).toBe(750_000);
      expect(() => suppliers.pay({
        supplierId: supplier.id,
        amount: 1,
        accountCode: "1300",
        reference: "",
        note: "",
      })).toThrowError(new FabricServiceError("VALIDATION", "Choose a configured cash or payment account."));
      expect(paymentDetails.payments[0]).toMatchObject({
        paymentMethod: "Mobile Wallet",
        amountMinor: 250_000,
      });
      const reversedPayment = suppliers.reversePayment({
        paymentId: paymentDetails.payments[0].id,
        reason: "Wrong supplier selected",
      });
      expect(reversedPayment.supplier.outstandingMinor).toBe(1_000_000);
      expect(reversedPayment.payments[0].reversedAt).toBeTruthy();
      expect(suppliers.reconcile().differenceMinor).toBe(0);
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

  it("creates, verifies, schedules, and restores a consistent SQLite backup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "greige-backup-recovery-"));
    temporaryDirectories.push(directory);
    const userDataDirectory = path.join(directory, "user-data");
    const applicationDirectory = path.join(directory, "application");
    await mkdir(applicationDirectory);
    const databasePath = path.join(userDataDirectory, "pos.sqlite");
    let database = await openDatabase(databasePath, migrationsDirectory);
    database.exec(`
      CREATE TABLE backup_probe (value TEXT NOT NULL);
      INSERT INTO backup_probe (value) VALUES ('before-backup');
    `);
    const backups = await BackupService.create(
      database,
      databasePath,
      userDataDirectory,
      applicationDirectory,
    );

    await expect(backups.setDestination(path.join(applicationDirectory, "backups")))
      .rejects.toThrow(/outside the application installation directory/);
    const backup = await backups.createBackup();
    expect(backups.verifyBackup(backup.path)).toMatchObject({
      integrity: "ok",
      foreignKeyViolations: 0,
    });
    database.prepare("UPDATE backup_probe SET value = 'after-backup'").run();

    await backups.setSchedule("daily");
    expect(await backups.runScheduledBackupIfDue(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)))
      .toBe(true);

    await backups.stageRestore(backup.path);
    database.close();
    expect(await BackupService.applyPendingRestore(databasePath, userDataDirectory)).toBe(true);

    database = await openDatabase(databasePath, migrationsDirectory);
    try {
      expect(database.prepare("SELECT value FROM backup_probe").get()).toEqual({ value: "before-backup" });
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(await readdir(userDataDirectory)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^before-restore-/),
      ]));
    } finally {
      database.close();
    }
  });

  it("rejects corrupt files as backups and prevents restoring the live database", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "greige-backup-validation-"));
    temporaryDirectories.push(directory);
    const userDataDirectory = path.join(directory, "user-data");
    const applicationDirectory = path.join(directory, "application");
    await mkdir(applicationDirectory);
    const databasePath = path.join(userDataDirectory, "pos.sqlite");
    const database = await openDatabase(databasePath, migrationsDirectory);
    const backups = await BackupService.create(
      database,
      databasePath,
      userDataDirectory,
      applicationDirectory,
    );
    const invalidFile = path.join(directory, "not-a-backup.sqlite");
    await writeFile(invalidFile, "not a sqlite database");
    expect(() => backups.verifyBackup(invalidFile)).toThrow(/readable SQLite database backup/);
    await expect(backups.stageRestore(databasePath)).rejects.toThrow(/cannot be selected as its own restore source/);
    database.close();
  });

  it("rolls back the receipt-table migration when a legacy payment account is invalid", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "greige-receipt-migration-"));
    temporaryDirectories.push(directory);
    const legacyMigrations = path.join(directory, "migrations");
    await mkdir(legacyMigrations);
    for (const name of (await readdir(migrationsDirectory)).filter((entry) => entry < "007_payments_and_receipts.sql")) {
      await copyFile(path.join(migrationsDirectory, name), path.join(legacyMigrations, name));
    }

    const databasePath = path.join(directory, "pos.sqlite");
    let database = await openDatabase(databasePath, legacyMigrations);
    const legacyReceiptColumns = database.prepare("PRAGMA table_info(customer_receipts)")
      .all() as Array<{ name: string }>;
    expect(legacyReceiptColumns.map((column) => column.name)).toContain("account_code");
    const dependencies = database.prepare(`
      SELECT type, name FROM sqlite_schema
      WHERE name != 'customer_receipts'
        AND (
          (type = 'view' AND lower(sql) LIKE '%customer_receipts%')
          OR (type = 'trigger' AND (
            tbl_name = 'customer_receipts' OR lower(sql) LIKE '%customer_receipts%'
          ))
          OR (type = 'table' AND lower(sql) LIKE '%references customer_receipts%')
        )
    `).all();
    expect(dependencies).toEqual([]);
    database.prepare(`
      INSERT INTO customers (id, code, name, created_at, updated_at)
      VALUES ('legacy-customer', 'LEGACY', 'Legacy Customer', '2025-01-01', '2025-01-01')
    `).run();
    database.pragma("ignore_check_constraints = ON");
    database.prepare(`
      INSERT INTO customer_receipts (
        id, customer_id, receipt_number, account_code, amount_minor, created_at
      ) VALUES ('legacy-receipt', 'legacy-customer', 'R-LEGACY', '9999', 5000, '2025-01-01')
    `).run();
    database.close();

    await expect(openDatabase(databasePath, migrationsDirectory)).rejects.toThrow();

    database = await openDatabase(databasePath, legacyMigrations);
    try {
      const appliedMigration = database.prepare(
        "SELECT name FROM schema_migrations WHERE name = '007_payments_and_receipts.sql'",
      ).get();
      expect(appliedMigration).toBeUndefined();
      const columns = database.prepare("PRAGMA table_info(customer_receipts)")
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("reversed_at");
      expect(database.prepare("SELECT id, account_code FROM customer_receipts")
        .get()).toEqual({ id: "legacy-receipt", account_code: "9999" });
    } finally {
      database.close();
    }
  });

  it("backfills existing journal entries into accounting periods without changing their postings", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "greige-accounting-migration-"));
    temporaryDirectories.push(directory);
    const oldMigrations = path.join(directory, "old-migrations");
    await mkdir(oldMigrations);
    for (const name of (await readdir(migrationsDirectory)).filter((entry) => entry < "009_accounting_engine.sql")) {
      await copyFile(path.join(migrationsDirectory, name), path.join(oldMigrations, name));
    }

    const databasePath = path.join(directory, "existing-pos.sqlite");
    let database = await openDatabase(databasePath, oldMigrations);
    database.prepare(`
      INSERT INTO ledger_transactions (id, transaction_type, reference, authorized_user, created_at)
      VALUES ('legacy-journal', 'legacy_adjustment', 'LEGACY-REF', 'Legacy', '2024-01-15T12:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO ledger_postings (id, transaction_id, account_code, debit_minor, credit_minor)
      VALUES
        ('legacy-debit', 'legacy-journal', '1000', 2500, 0),
        ('legacy-credit', 'legacy-journal', '4000', 0, 2500)
    `).run();
    database.close();

    database = await openDatabase(databasePath, migrationsDirectory);
    try {
      expect(database.prepare(`
        SELECT source_key, period_id FROM ledger_transactions WHERE id = 'legacy-journal'
      `).get()).toEqual({ source_key: "legacy:legacy-journal", period_id: "2024-01" });
      expect(database.prepare(`
        SELECT id, status FROM accounting_periods WHERE id = '2024-01'
      `).get()).toEqual({ id: "2024-01", status: "open" });
      expect(database.prepare(`
        SELECT account_code, SUM(debit_minor) AS debit, SUM(credit_minor) AS credit
        FROM ledger_postings WHERE transaction_id = 'legacy-journal'
        GROUP BY account_code ORDER BY account_code
      `).all()).toEqual([
        { account_code: "1000", debit: 2500, credit: 0 },
        { account_code: "4000", debit: 0, credit: 2500 },
      ]);
      expect(database.prepare(`
        SELECT normal_balance FROM ledger_accounts WHERE code = '4000'
      `).get()).toEqual({ normal_balance: "credit" });
      expect(() => database.prepare(`
        UPDATE ledger_transactions SET reference = 'mutated' WHERE id = 'legacy-journal'
      `).run()).toThrow(/immutable/);
    } finally {
      database.close();
    }
  });

  it("allocates legacy invoice COGS snapshots exactly to the posted sale total", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "greige-return-migration-"));
    temporaryDirectories.push(directory);
    const oldMigrations = path.join(directory, "old-migrations");
    await mkdir(oldMigrations);
    for (const name of (await readdir(migrationsDirectory)).filter((entry) => entry < "012_returns_and_audit.sql")) {
      await copyFile(path.join(migrationsDirectory, name), path.join(oldMigrations, name));
    }

    const databasePath = path.join(directory, "existing-pos.sqlite");
    let database = await openDatabase(databasePath, oldMigrations);
    database.prepare(`
      INSERT INTO fabrics (
        id, sku, name, construction, composition, width_inches, gsm,
        purchase_cost_minor, selling_rate_minor, reorder_threshold_mm, created_at, updated_at
      ) VALUES ('legacy-fabric', 'LEGACY-FABRIC', 'Legacy Fabric', '60 x 60', 'Cotton',
        63, 110, 14500, 18000, 500000, '2026-10-01', '2026-10-01')
    `).run();
    database.prepare(`
      INSERT INTO invoices (id, invoice_number, total_minor, created_at)
      VALUES ('legacy-invoice', 'INV-LEGACY', 3, '2026-10-01T12:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO invoice_items (
        id, invoice_id, fabric_id, sku_snapshot, name_snapshot, quantity_mm,
        unit_price_minor, line_total_minor
      ) VALUES
        ('legacy-line-1', 'legacy-invoice', 'legacy-fabric', 'LEGACY-FABRIC', 'Legacy Fabric', 1, 1000, 1),
        ('legacy-line-2', 'legacy-invoice', 'legacy-fabric', 'LEGACY-FABRIC', 'Legacy Fabric', 1, 1000, 1),
        ('legacy-line-3', 'legacy-invoice', 'legacy-fabric', 'LEGACY-FABRIC', 'Legacy Fabric', 1, 1000, 1)
    `).run();
    database.prepare(`
      INSERT INTO ledger_transactions (id, transaction_type, reference, authorized_user, created_at)
      VALUES ('legacy-sale', 'sale', 'INV-LEGACY', 'System', '2026-10-01T12:00:00.000Z')
    `).run();
    database.prepare(`
      INSERT INTO ledger_postings (id, transaction_id, account_code, debit_minor, credit_minor)
      VALUES
        ('legacy-sale-cogs', 'legacy-sale', '5000', 2, 0),
        ('legacy-sale-inventory', 'legacy-sale', '1200', 0, 2)
    `).run();
    database.close();

    database = await openDatabase(databasePath, migrationsDirectory);
    try {
      const allocation = database.prepare(`
        SELECT SUM(cost_of_goods_sold_minor) AS total
        FROM invoice_items WHERE invoice_id = 'legacy-invoice'
      `).get() as { total: number };
      expect(allocation.total).toBe(2);
    } finally {
      database.close();
    }
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

  it("uses unused expense accounts when migration codes already belong to user accounts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "greige-expense-migration-"));
    temporaryDirectories.push(directory);
    const oldMigrations = path.join(directory, "old-migrations");
    await mkdir(oldMigrations);
    for (const name of (await readdir(migrationsDirectory)).filter((entry) => entry < "010_expenses.sql")) {
      await copyFile(path.join(migrationsDirectory, name), path.join(oldMigrations, name));
    }

    const databasePath = path.join(directory, "existing-pos.sqlite");
    let database = await openDatabase(databasePath, oldMigrations);
    database.prepare(`
      INSERT INTO ledger_accounts (code, name, account_type, normal_balance)
      VALUES ('5200', 'User asset account', 'asset', 'debit'),
        ('5400', 'User expense account', 'expense', 'debit')
    `).run();
    database.close();

    database = await openDatabase(databasePath, migrationsDirectory);
    try {
      expect(database.prepare("SELECT name, account_type FROM ledger_accounts WHERE code = '5200'")
        .get()).toEqual({ name: "User asset account", account_type: "asset" });
      expect(database.prepare("SELECT name, account_type FROM ledger_accounts WHERE code = '5400'")
        .get()).toEqual({ name: "User expense account", account_type: "expense" });
      expect(database.prepare(`
        SELECT c.code, c.account_code, a.account_type
        FROM expense_categories c
        JOIN ledger_accounts a ON a.code = c.account_code
        WHERE c.code IN ('rent', 'transport')
        ORDER BY c.code
      `).all()).toEqual([
        { code: "rent", account_code: expect.not.stringMatching(/^5200$/), account_type: "expense" },
        { code: "transport", account_code: expect.not.stringMatching(/^5400$/), account_type: "expense" },
      ]);
    } finally {
      database.close();
    }
  });
});
