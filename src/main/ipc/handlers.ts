import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { MessageBoxOptions } from "electron";
import { z } from "zod";
import {
  createInvoiceSchema,
  returnDataSchema,
  backupScheduleSchema,
  salesReturnSchema,
  purchaseReturnSchema,
  returnReversalSchema,
  accountingClosePeriodSchema,
  accountingCreateAccountSchema,
  accountingEntryIdSchema,
  accountingEntryListSchema,
  accountingEntryReversalSchema,
  accountingGeneralLedgerSchema,
  accountingManualEntrySchema,
  accountingOpeningBalancesSchema,
  accountingTrialBalanceSchema,
  accountingUpdateAccountSchema,
  expenseCategoryInputSchema,
  expenseInputSchema,
  expenseRangeSchema,
  partnerAllocationPostSchema,
  partnerAllocationPreviewSchema,
  partnerIdSchema,
  partnerInputSchema,
  partnerListSchema,
  partnerStatementSchema,
  partnerTransactionInputSchema,
  partnerTransactionHistorySchema,
  partnerTransactionReversalSchema,
  analyticsReportSchema,
  printDocumentSchema,
  customerInputSchema,
  customerListSchema,
  customerReceiptSchema,
  customerReceiptReversalSchema,
  customerStatementSchema,
  fabricFiltersSchema,
  fabricIdSchema,
  fabricInputSchema,
  openingStockSchema,
  stockAdjustmentSchema,
  supplierAdjustmentSchema,
  supplierIdSchema,
  supplierInputSchema,
  supplierListSchema,
  supplierPaymentSchema,
  supplierPaymentReversalSchema,
  supplierPurchaseSchema,
  supplierStatementSchema,
  updateFabricSchema,
  updateSupplierSchema,
  updateCustomerSchema,
  type IpcErrorCode,
  type IpcResult,
} from "../../shared/contracts";
import { channels } from "../../shared/channels";
import { FabricServiceError } from "../services/errors";
import { InventoryService } from "../services/inventory";
import { SupplierService } from "../services/suppliers";
import { FabricService } from "../services/fabrics";
import { CustomerService } from "../services/customers";
import { AccountingService } from "../services/accounting";
import { ExpenseService } from "../services/expenses";
import { PartnerService } from "../services/partners";
import { ReportsService } from "../services/reports";
import { ReturnsService } from "../services/returns";
import { BackupService } from "../services/backups";
import { isTrustedSender } from "./security";

function failure<T>(code: IpcErrorCode, message: string): IpcResult<T> {
  return { ok: false, error: { code, message } };
}

function registerHandler<Input, Output, Service>(
  channel: string,
  service: Service,
  developmentUrl: string | undefined,
  productionFileUrl: string,
  schema: z.ZodType<Input>,
  handler: (service: Service, input: Input) => Output | Promise<Output>,
): void {
  ipcMain.handle(channel, async (event, rawInput): Promise<IpcResult<Output>> => {
    const frame = event.senderFrame;
    if (
      !frame ||
      !isTrustedSender(frame.url, frame === event.sender.mainFrame, developmentUrl, productionFileUrl)
    ) {
      return failure("VALIDATION", "Untrusted application frame.");
    }

    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) {
      return failure("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request.");
    }

    try {
      return { ok: true, data: await handler(service, parsed.data) };
    } catch (error) {
      if (error instanceof FabricServiceError) return failure(error.code, error.message);
      if (error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return failure("CONFLICT", "A record with the same unique value already exists.");
      }
      console.error(`IPC request failed on ${channel}.`, error);
      return failure("INTERNAL", "The request could not be completed.");
    }
  });
}

export function registerIpcHandlers(
  fabrics: FabricService,
  inventory: InventoryService,
  suppliers: SupplierService,
  customers: CustomerService,
  accounting: AccountingService,
  expenses: ExpenseService,
  partners: PartnerService,
  reports: ReportsService,
  returns: ReturnsService,
  backups: BackupService,
  developmentUrl: string | undefined,
  productionFileUrl: string,
): void {
  registerHandler(
    channels.backupSettings, backups, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.getSettings(),
  );
  registerHandler(
    channels.backupCreate, backups, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.createBackup(),
  );
  registerHandler(
    channels.backupSetSchedule, backups, developmentUrl, productionFileUrl,
    backupScheduleSchema, (service, input) => service.setSchedule(input.frequency),
  );
  ipcMain.handle(channels.backupChooseDestination, async (event, rawInput): Promise<IpcResult<Awaited<ReturnType<BackupService["getSettings"]>>>> => {
    const frame = event.senderFrame;
    if (!frame || !isTrustedSender(frame.url, frame === event.sender.mainFrame, developmentUrl, productionFileUrl)) {
      return failure("VALIDATION", "Untrusted application frame.");
    }
    try {
      const parsed = z.undefined().safeParse(rawInput);
      if (!parsed.success) return failure("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request.");
      const selected = await dialog.showOpenDialog({
        title: "Choose backup destination",
        properties: ["openDirectory", "createDirectory"],
      });
      if (selected.canceled || !selected.filePaths[0]) {
        return { ok: true, data: await backups.getSettings() };
      }
      return { ok: true, data: await backups.setDestination(selected.filePaths[0]) };
    } catch (error) {
      if (error instanceof FabricServiceError) return failure(error.code, error.message);
      console.error("Could not select the backup destination.", error);
      return failure("INTERNAL", "The backup destination could not be selected.");
    }
  });
  ipcMain.handle(channels.backupVerify, async (event, rawInput): Promise<IpcResult<Awaited<ReturnType<BackupService["verifyBackup"]>> | null>> => {
    const frame = event.senderFrame;
    if (!frame || !isTrustedSender(frame.url, frame === event.sender.mainFrame, developmentUrl, productionFileUrl)) {
      return failure("VALIDATION", "Untrusted application frame.");
    }
    try {
      const parsed = z.undefined().safeParse(rawInput);
      if (!parsed.success) return failure("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request.");
      const selected = await dialog.showOpenDialog({
        title: "Select a database backup to verify",
        properties: ["openFile"],
        filters: [{ name: "SQLite backup", extensions: ["sqlite", "db", "bak"] }],
      });
      if (selected.canceled || !selected.filePaths[0]) return { ok: true, data: null };
      return { ok: true, data: backups.verifyBackup(selected.filePaths[0]) };
    } catch (error) {
      if (error instanceof FabricServiceError) return failure(error.code, error.message);
      console.error("Backup verification failed.", error);
      return failure("INTERNAL", "The selected backup could not be verified.");
    }
  });
  ipcMain.handle(channels.backupRestore, async (event, rawInput): Promise<IpcResult<{ restarting: boolean }>> => {
    const frame = event.senderFrame;
    if (!frame || !isTrustedSender(frame.url, frame === event.sender.mainFrame, developmentUrl, productionFileUrl)) {
      return failure("VALIDATION", "Untrusted application frame.");
    }
    try {
      const parsed = z.undefined().safeParse(rawInput);
      if (!parsed.success) return failure("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid request.");
      const selected = await dialog.showOpenDialog({
        title: "Select a database backup to restore",
        properties: ["openFile"],
        filters: [{ name: "SQLite backup", extensions: ["sqlite", "db", "bak"] }],
      });
      if (selected.canceled || !selected.filePaths[0]) return { ok: true, data: { restarting: false } };
      const verification = backups.verifyBackup(selected.filePaths[0]);
      const options: MessageBoxOptions = {
        type: "warning",
        title: "Restore database backup?",
        message: "Restore this database backup and restart Greige Fabric POS?",
        detail: `${verification.path}\n\nThe current database will be preserved as a recovery backup before the selected file is restored.`,
        buttons: ["Cancel", "Restore and restart"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const parent = BrowserWindow.fromWebContents(event.sender);
      const confirmation = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      if (confirmation.response !== 1) return { ok: true, data: { restarting: false } };
      await backups.stageRestore(selected.filePaths[0]);
      app.relaunch();
      app.quit();
      return { ok: true, data: { restarting: true } };
    } catch (error) {
      if (error instanceof FabricServiceError) return failure(error.code, error.message);
      console.error("Database restore could not be staged.", error);
      return failure("INTERNAL", "The database restore could not be staged.");
    }
  });

  registerHandler(
    channels.runAnalyticsReport, reports, developmentUrl, productionFileUrl,
    analyticsReportSchema, (service, input) => service.run(input),
  );
  registerHandler(
    channels.returnsData, returns, developmentUrl, productionFileUrl,
    returnDataSchema, (service) => service.data(),
  );
  registerHandler(
    channels.createSalesReturn, returns, developmentUrl, productionFileUrl,
    salesReturnSchema, (service, input) => service.createSales(input, "Staff"),
  );
  registerHandler(
    channels.createPurchaseReturn, returns, developmentUrl, productionFileUrl,
    purchaseReturnSchema, (service, input) => service.createPurchase(input, "Staff"),
  );
  registerHandler(
    channels.reverseReturn, returns, developmentUrl, productionFileUrl,
    returnReversalSchema, (service, input) => service.reverse(input, "Staff"),
  );

  ipcMain.handle(channels.printDocument, async (event, rawInput): Promise<IpcResult<{ printed: boolean }>> => {
    const frame = event.senderFrame;
    if (
      !frame ||
      !isTrustedSender(frame.url, frame === event.sender.mainFrame, developmentUrl, productionFileUrl)
    ) {
      return failure("VALIDATION", "Untrusted application frame.");
    }
    const parsed = printDocumentSchema.safeParse(rawInput);
    if (!parsed.success) {
      return failure("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid print request.");
    }
    try {
      return await new Promise((resolve) => {
        event.sender.print({
          silent: false,
          printBackground: true,
          pageSize: parsed.data.paperFormat,
        }, (success, failureReason) => {
          if (success) resolve({ ok: true, data: { printed: true } });
          else if (failureReason === "Print job canceled") {
            resolve({ ok: true, data: { printed: false } });
          } else {
            console.error("Document printing failed.", failureReason);
            resolve(failure("INTERNAL", "The document could not be printed."));
          }
        });
      });
    } catch (error) {
      console.error("Document printing failed.", error);
      return failure("INTERNAL", "The document could not be printed.");
    }
  });

  registerHandler(
    channels.listFabrics, fabrics, developmentUrl, productionFileUrl,
    fabricFiltersSchema, (service, input) => service.list(input),
  );
  registerHandler(
    channels.getFabric, fabrics, developmentUrl, productionFileUrl,
    fabricIdSchema, (service, input) => service.get(input.id),
  );
  registerHandler(
    channels.createFabric, fabrics, developmentUrl, productionFileUrl,
    fabricInputSchema, (service, input) => service.create(input),
  );
  registerHandler(
    channels.updateFabric, fabrics, developmentUrl, productionFileUrl,
    updateFabricSchema, (service, input) => service.update(input),
  );
  registerHandler(
    channels.setFabricActive, fabrics, developmentUrl, productionFileUrl,
    fabricIdSchema.extend({ active: z.boolean() }),
    (service, input) => service.setActive(input.id, input.active),
  );
  registerHandler(
    channels.stockSummary, fabrics, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.stockSummary(),
  );
  registerHandler(
    channels.adjustStock, fabrics, developmentUrl, productionFileUrl,
    stockAdjustmentSchema,
    (service, input) => service.adjustStock(input, "Staff"),
  );
  registerHandler(
    channels.inventoryReport, inventory, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.report(),
  );
  registerHandler(
    channels.inventoryMovements, inventory, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.movements(),
  );
  registerHandler(
    channels.inventoryOpening, inventory, developmentUrl, productionFileUrl,
    openingStockSchema,
    (service, input) => {
      service.openStock(input, "Staff");
      return fabrics.get(input.fabricId).fabric;
    },
  );
  registerHandler(
    channels.listInvoices, fabrics, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.listInvoices(),
  );
  registerHandler(
    channels.createInvoice, fabrics, developmentUrl, productionFileUrl,
    createInvoiceSchema, (service, input) => service.createInvoice(input),
  );
  registerHandler(
    channels.listSuppliers, suppliers, developmentUrl, productionFileUrl,
    supplierListSchema, (service, input) => service.list(input),
  );
  registerHandler(
    channels.getSupplier, suppliers, developmentUrl, productionFileUrl,
    supplierIdSchema, (service, input) => service.get(input.id),
  );
  registerHandler(
    channels.createSupplier, suppliers, developmentUrl, productionFileUrl,
    supplierInputSchema, (service, input) => service.create(input, "Staff"),
  );
  registerHandler(
    channels.updateSupplier, suppliers, developmentUrl, productionFileUrl,
    updateSupplierSchema, (service, input) => service.update(input),
  );
  registerHandler(
    channels.receiveSupplierPurchase, suppliers, developmentUrl, productionFileUrl,
    supplierPurchaseSchema, (service, input) => service.receive(input),
  );
  registerHandler(
    channels.paySupplier, suppliers, developmentUrl, productionFileUrl,
    supplierPaymentSchema, (service, input) => service.pay(input),
  );
  registerHandler(
    channels.reverseSupplierPayment, suppliers, developmentUrl, productionFileUrl,
    supplierPaymentReversalSchema, (service, input) => service.reversePayment(input, "Staff"),
  );
  registerHandler(
    channels.adjustSupplier, suppliers, developmentUrl, productionFileUrl,
    supplierAdjustmentSchema,
    (service, input) => service.adjust(input, "Staff"),
  );
  registerHandler(
    channels.supplierStatement, suppliers, developmentUrl, productionFileUrl,
    supplierStatementSchema, (service, input) => service.statement(input),
  );
  registerHandler(
    channels.supplierReconcile, suppliers, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.reconcile(),
  );
  registerHandler(
    channels.listCustomers, customers, developmentUrl, productionFileUrl,
    customerListSchema, (service, input) => service.list(input),
  );
  registerHandler(
    channels.getCustomer, customers, developmentUrl, productionFileUrl,
    supplierIdSchema, (service, input) => service.get(input.id),
  );
  registerHandler(
    channels.createCustomer, customers, developmentUrl, productionFileUrl,
    customerInputSchema, (service, input) => service.create(input, "Staff"),
  );
  registerHandler(
    channels.updateCustomer, customers, developmentUrl, productionFileUrl,
    updateCustomerSchema, (service, input) => service.update(input),
  );
  registerHandler(
    channels.receiveCustomer, customers, developmentUrl, productionFileUrl,
    customerReceiptSchema, (service, input) => service.receive(input),
  );
  registerHandler(
    channels.reverseCustomerReceipt, customers, developmentUrl, productionFileUrl,
    customerReceiptReversalSchema, (service, input) => service.reverseReceipt(input, "Staff"),
  );
  registerHandler(
    channels.customerPaymentAccounts, customers, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.paymentAccounts(),
  );
  registerHandler(
    channels.customerStatement, customers, developmentUrl, productionFileUrl,
    customerStatementSchema, (service, input) => service.statement(input),
  );
  registerHandler(
    channels.accountingAccounts, accounting, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.listAccounts(),
  );
  registerHandler(
    channels.accountingCreateAccount, accounting, developmentUrl, productionFileUrl,
    accountingCreateAccountSchema, (service, input) => service.createAccount(input),
  );
  registerHandler(
    channels.accountingUpdateAccount, accounting, developmentUrl, productionFileUrl,
    accountingUpdateAccountSchema, (service, input) => service.updateAccount(input),
  );
  registerHandler(
    channels.accountingPeriods, accounting, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.listPeriods(),
  );
  registerHandler(
    channels.accountingClosePeriod, accounting, developmentUrl, productionFileUrl,
    accountingClosePeriodSchema, (service, input) => service.closePeriod(input.id),
  );
  registerHandler(
    channels.accountingTrialBalance, accounting, developmentUrl, productionFileUrl,
    accountingTrialBalanceSchema, (service, input) => service.trialBalance(input.asOf),
  );
  registerHandler(
    channels.accountingGeneralLedger, accounting, developmentUrl, productionFileUrl,
    accountingGeneralLedgerSchema, (service, input) => service.generalLedger(input),
  );
  registerHandler(
    channels.accountingEntries, accounting, developmentUrl, productionFileUrl,
    accountingEntryListSchema, (service, input) => service.listEntries(input.limit),
  );
  registerHandler(
    channels.accountingEntry, accounting, developmentUrl, productionFileUrl,
    accountingEntryIdSchema, (service, input) => service.getEntry(input.id),
  );
  registerHandler(
    channels.accountingPostEntry, accounting, developmentUrl, productionFileUrl,
    accountingManualEntrySchema, (service, input) => service.postEntry(input),
  );
  registerHandler(
    channels.accountingOpeningBalances, accounting, developmentUrl, productionFileUrl,
    accountingOpeningBalancesSchema, (service, input) => service.postOpeningBalances(input),
  );
  registerHandler(
    channels.accountingReverseEntry, accounting, developmentUrl, productionFileUrl,
    accountingEntryReversalSchema, (service, input) => service.reverseEntry(input.id, input.reason),
  );
  registerHandler(
    channels.accountingReconcile, accounting, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.reconcile(),
  );
  registerHandler(
    channels.expenseCategories, expenses, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.categories(),
  );
  registerHandler(
    channels.addExpenseCategory, expenses, developmentUrl, productionFileUrl,
    expenseCategoryInputSchema, (service, input) => service.addCategory(input),
  );
  registerHandler(
    channels.recordExpense, expenses, developmentUrl, productionFileUrl,
    expenseInputSchema, (service, input) => service.record(input),
  );
  registerHandler(
    channels.listExpenses, expenses, developmentUrl, productionFileUrl,
    expenseRangeSchema, (service, input) => service.list(input),
  );
  registerHandler(
    channels.expenseReport, expenses, developmentUrl, productionFileUrl,
    expenseRangeSchema, (service, input) => service.report(input),
  );
  registerHandler(
    channels.partnerDashboard, partners, developmentUrl, productionFileUrl,
    expenseRangeSchema, (service, input) => service.dashboard(input),
  );
  registerHandler(
    channels.partnerList, partners, developmentUrl, productionFileUrl,
    partnerListSchema, (service, input) => service.list(input),
  );
  registerHandler(
    channels.partnerGet, partners, developmentUrl, productionFileUrl,
    partnerIdSchema, (service, input) => service.get(input.id),
  );
  registerHandler(
    channels.partnerSave, partners, developmentUrl, productionFileUrl,
    partnerInputSchema, (service, input) => service.save(input),
  );
  registerHandler(
    channels.partnerSetActive, partners, developmentUrl, productionFileUrl,
    partnerIdSchema.extend({ active: z.boolean() }),
    (service, input) => service.setActive(input.id, input.active),
  );
  registerHandler(
    channels.partnerPaymentAccounts, partners, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.paymentAccounts(),
  );
  registerHandler(
    channels.partnerPostTransaction, partners, developmentUrl, productionFileUrl,
    partnerTransactionInputSchema, (service, input) => service.postTransaction(input),
  );
  registerHandler(
    channels.partnerTransactions, partners, developmentUrl, productionFileUrl,
    partnerTransactionHistorySchema, (service, input) => service.transactions(input),
  );
  registerHandler(
    channels.partnerAllocationPreview, partners, developmentUrl, productionFileUrl,
    partnerAllocationPreviewSchema, (service, input) => service.allocationPreview(input.periodId),
  );
  registerHandler(
    channels.partnerPostAllocation, partners, developmentUrl, productionFileUrl,
    partnerAllocationPostSchema, (service, input) => service.postAllocation(input),
  );
  registerHandler(
    channels.partnerStatement, partners, developmentUrl, productionFileUrl,
    partnerStatementSchema, (service, input) => service.statement(input),
  );
  registerHandler(
    channels.partnerReverse, partners, developmentUrl, productionFileUrl,
    partnerTransactionReversalSchema, (service, input) => service.reverse(input),
  );
}
