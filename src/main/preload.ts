import { contextBridge, ipcRenderer } from "electron";
import { channels } from "../shared/channels";
import type { DesktopApi } from "../shared/types";

const api: DesktopApi = {
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
  auth: {
    pinStatus: () => ipcRenderer.invoke(channels.pinStatus),
    setPin: (input) => ipcRenderer.invoke(channels.setPin, input),
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
};

contextBridge.exposeInMainWorld("electronAPI", api);
