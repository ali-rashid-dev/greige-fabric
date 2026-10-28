import { contextBridge, ipcRenderer } from "electron";
import { channels } from "../shared/channels";
import type { DesktopApi } from "../shared/types";

const api: DesktopApi = {
  backups: {
    settings: () => ipcRenderer.invoke(channels.backupSettings),
    create: () => ipcRenderer.invoke(channels.backupCreate),
    chooseDestination: () => ipcRenderer.invoke(channels.backupChooseDestination),
    setSchedule: (input) => ipcRenderer.invoke(channels.backupSetSchedule, input),
    verify: () => ipcRenderer.invoke(channels.backupVerify),
    restore: () => ipcRenderer.invoke(channels.backupRestore),
  },
  returns: {
    data: () => ipcRenderer.invoke(channels.returnsData),
    createSales: (input) => ipcRenderer.invoke(channels.createSalesReturn, input),
    createPurchase: (input) => ipcRenderer.invoke(channels.createPurchaseReturn, input),
    reverse: (input) => ipcRenderer.invoke(channels.reverseReturn, input),
  },
  reports: {
    run: (input) => ipcRenderer.invoke(channels.runAnalyticsReport, input),
  },
  documents: {
    print: (input) => ipcRenderer.invoke(channels.printDocument, input),
  },
  fabrics: {
    list: (filters = {}) => ipcRenderer.invoke(channels.listFabrics, filters),
    get: (input) => ipcRenderer.invoke(channels.getFabric, input),
    create: (input) => ipcRenderer.invoke(channels.createFabric, input),
    update: (input) => ipcRenderer.invoke(channels.updateFabric, input),
    setActive: (input) => ipcRenderer.invoke(channels.setFabricActive, input),
  },
  stock: {
    summary: () => ipcRenderer.invoke(channels.stockSummary),
    adjust: (input) => ipcRenderer.invoke(channels.adjustStock, input),
  },
  inventory: {
    report: () => ipcRenderer.invoke(channels.inventoryReport),
    movements: () => ipcRenderer.invoke(channels.inventoryMovements),
    opening: (input) => ipcRenderer.invoke(channels.inventoryOpening, input),
  },
  suppliers: {
    list: (input) => ipcRenderer.invoke(channels.listSuppliers, input ?? {}),
    get: (input) => ipcRenderer.invoke(channels.getSupplier, input),
    create: (input) => ipcRenderer.invoke(channels.createSupplier, input),
    update: (input) => ipcRenderer.invoke(channels.updateSupplier, input),
    receive: (input) => ipcRenderer.invoke(channels.receiveSupplierPurchase, input),
    pay: (input) => ipcRenderer.invoke(channels.paySupplier, input),
    reversePayment: (input) => ipcRenderer.invoke(channels.reverseSupplierPayment, input),
    adjust: (input) => ipcRenderer.invoke(channels.adjustSupplier, input),
    statement: (input) => ipcRenderer.invoke(channels.supplierStatement, input),
    reconcile: () => ipcRenderer.invoke(channels.supplierReconcile),
  },
  customers: {
    list: (input) => ipcRenderer.invoke(channels.listCustomers, input ?? {}),
    get: (input) => ipcRenderer.invoke(channels.getCustomer, input),
    create: (input) => ipcRenderer.invoke(channels.createCustomer, input),
    update: (input) => ipcRenderer.invoke(channels.updateCustomer, input),
    receive: (input) => ipcRenderer.invoke(channels.receiveCustomer, input),
    reverseReceipt: (input) => ipcRenderer.invoke(channels.reverseCustomerReceipt, input),
    paymentAccounts: () => ipcRenderer.invoke(channels.customerPaymentAccounts),
    statement: (input) => ipcRenderer.invoke(channels.customerStatement, input),
  },
  invoices: {
    list: () => ipcRenderer.invoke(channels.listInvoices),
    create: (input) => ipcRenderer.invoke(channels.createInvoice, input),
  },
  accounting: {
    accounts: () => ipcRenderer.invoke(channels.accountingAccounts),
    createAccount: (input) => ipcRenderer.invoke(channels.accountingCreateAccount, input),
    updateAccount: (input) => ipcRenderer.invoke(channels.accountingUpdateAccount, input),
    periods: () => ipcRenderer.invoke(channels.accountingPeriods),
    closePeriod: (input) => ipcRenderer.invoke(channels.accountingClosePeriod, input),
    trialBalance: (input) => ipcRenderer.invoke(channels.accountingTrialBalance, input),
    generalLedger: (input) => ipcRenderer.invoke(channels.accountingGeneralLedger, input),
    entries: (input = {}) => ipcRenderer.invoke(channels.accountingEntries, input),
    entry: (input) => ipcRenderer.invoke(channels.accountingEntry, input),
    postEntry: (input) => ipcRenderer.invoke(channels.accountingPostEntry, input),
    openingBalances: (input) => ipcRenderer.invoke(channels.accountingOpeningBalances, input),
    reverseEntry: (input) => ipcRenderer.invoke(channels.accountingReverseEntry, input),
    reconcile: () => ipcRenderer.invoke(channels.accountingReconcile),
  },
  expenses: {
    categories: () => ipcRenderer.invoke(channels.expenseCategories),
    addCategory: (input) => ipcRenderer.invoke(channels.addExpenseCategory, input),
    record: (input) => ipcRenderer.invoke(channels.recordExpense, input),
    list: (input) => ipcRenderer.invoke(channels.listExpenses, input),
    report: (input) => ipcRenderer.invoke(channels.expenseReport, input),
  },
  partners: {
    dashboard: (input) => ipcRenderer.invoke(channels.partnerDashboard, input),
    list: (input) => ipcRenderer.invoke(channels.partnerList, input),
    get: (input) => ipcRenderer.invoke(channels.partnerGet, input),
    save: (input) => ipcRenderer.invoke(channels.partnerSave, input),
    setActive: (input) => ipcRenderer.invoke(channels.partnerSetActive, input),
    paymentAccounts: () => ipcRenderer.invoke(channels.partnerPaymentAccounts),
    postTransaction: (input) => ipcRenderer.invoke(channels.partnerPostTransaction, input),
    transactions: (input) => ipcRenderer.invoke(channels.partnerTransactions, input),
    allocationPreview: (input) => ipcRenderer.invoke(channels.partnerAllocationPreview, input),
    postAllocation: (input) => ipcRenderer.invoke(channels.partnerPostAllocation, input),
    statement: (input) => ipcRenderer.invoke(channels.partnerStatement, input),
    reverse: (input) => ipcRenderer.invoke(channels.partnerReverse, input),
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
