import { ipcMain } from "electron";
import { z } from "zod";
import {
  createInvoiceSchema,
  returnDataSchema,
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
  pinSetupSchema,
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
import { OwnerAuthService } from "../services/owner-auth";
import { InventoryService } from "../services/inventory";
import { SupplierService } from "../services/suppliers";
import { FabricService } from "../services/fabrics";
import { CustomerService } from "../services/customers";
import { AccountingService } from "../services/accounting";
import { ExpenseService } from "../services/expenses";
import { ReportsService } from "../services/reports";
import { ReturnsService } from "../services/returns";
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
  ownerAuth: OwnerAuthService,
  customers: CustomerService,
  accounting: AccountingService,
  expenses: ExpenseService,
  reports: ReportsService,
  returns: ReturnsService,
  developmentUrl: string | undefined,
  productionFileUrl: string,
): void {
  registerHandler(
    channels.runAnalyticsReport, reports, developmentUrl, productionFileUrl,
    analyticsReportSchema, async (service, input) => {
      const { ownerPin, ...reportInput } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.run(reportInput);
    },
  );
  registerHandler(
    channels.returnsData, returns, developmentUrl, productionFileUrl,
    returnDataSchema, async (service, input) => {
      if (!await ownerAuth.verifyPin(input.ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.data();
    },
  );
  registerHandler(
    channels.createSalesReturn, returns, developmentUrl, productionFileUrl,
    salesReturnSchema, async (service, input) => {
      const { ownerPin, ...returnInput } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.createSales(returnInput, "Owner");
    },
  );
  registerHandler(
    channels.createPurchaseReturn, returns, developmentUrl, productionFileUrl,
    purchaseReturnSchema, async (service, input) => {
      const { ownerPin, ...returnInput } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.createPurchase(returnInput, "Owner");
    },
  );
  registerHandler(
    channels.reverseReturn, returns, developmentUrl, productionFileUrl,
    returnReversalSchema, async (service, input) => {
      const { ownerPin, ...reversal } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.reverse(reversal, "Owner");
    },
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
    async (service, input) => {
      const { ownerPin, ...adjustment } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.adjustStock(adjustment, "Owner");
    },
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
    async (service, input) => {
      const { ownerPin, ...opening } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      service.openStock(opening, "Owner");
      return fabrics.get(opening.fabricId).fabric;
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
    channels.pinStatus, ownerAuth, developmentUrl, productionFileUrl,
    z.undefined(), (service) => service.pinStatus(),
  );
  registerHandler(
    channels.setPin, ownerAuth, developmentUrl, productionFileUrl,
    pinSetupSchema, (service, input) => service.setPin(input.pin),
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
    supplierInputSchema,
    async (service, input) => {
      const { ownerPin, ...supplierInput } = input;
      if (input.openingBalance > 0 && !await ownerAuth.verifyPin(ownerPin ?? "")) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.create(supplierInput, input.openingBalance > 0 ? "Owner" : "System");
    },
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
    supplierPaymentReversalSchema, async (service, input) => {
      const { ownerPin, ...reversal } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.reversePayment(reversal, "Owner");
    },
  );
  registerHandler(
    channels.adjustSupplier, suppliers, developmentUrl, productionFileUrl,
    supplierAdjustmentSchema,
    async (service, input) => {
      const { ownerPin, ...adjustment } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.adjust(adjustment, "Owner");
    },
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
    customerInputSchema,
    async (service, input) => {
      const { ownerPin, ...customerInput } = input;
      if (input.openingBalance > 0 && !await ownerAuth.verifyPin(ownerPin ?? "")) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.create(customerInput, input.openingBalance > 0 ? "Owner" : "System");
    },
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
    customerReceiptReversalSchema, async (service, input) => {
      const { ownerPin, ...reversal } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.reverseReceipt(reversal, "Owner");
    },
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
    accountingClosePeriodSchema, async (service, input) => {
      const { ownerPin, id } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.closePeriod(id);
    },
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
    accountingManualEntrySchema, async (service, input) => {
      const { ownerPin, ...entry } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.postEntry(entry);
    },
  );
  registerHandler(
    channels.accountingOpeningBalances, accounting, developmentUrl, productionFileUrl,
    accountingOpeningBalancesSchema, async (service, input) => {
      const { ownerPin, ...openingBalances } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.postOpeningBalances(openingBalances);
    },
  );
  registerHandler(
    channels.accountingReverseEntry, accounting, developmentUrl, productionFileUrl,
    accountingEntryReversalSchema, async (service, input) => {
      const { ownerPin, id, reason } = input;
      if (!await ownerAuth.verifyPin(ownerPin)) {
        throw new FabricServiceError("AUTHORIZATION", "The owner PIN is incorrect.");
      }
      return service.reverseEntry(id, reason);
    },
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
}
