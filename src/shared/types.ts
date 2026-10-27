import type { IpcResult } from "./contracts";
import type {
  CreateInvoiceInput,
  CustomerInput,
  CustomerListInput,
  CustomerReceiptInput,
  CustomerStatementInput,
  AccountingCreateAccountInput,
  AccountingClosePeriodInput,
  AccountingEntryListInput,
  AccountingEntryReversalInput,
  AccountingGeneralLedgerInput,
  AccountingManualEntryInput,
  AccountingOpeningBalancesInput,
  AccountingTrialBalanceInput,
  AccountingUpdateAccountInput,
  ExpenseCategoryInput,
  ExpenseInput,
  ExpenseRangeInput,
  ReturnDataInput,
  SalesReturnInput,
  PurchaseReturnInput,
  ReturnReversalInput,
  AnalyticsReportInput,
  PrintDocumentInput,
  FabricFiltersInput,
  FabricIdInput,
  FabricInput,
  OpeningStockInput,
  StockAdjustmentInput,
  SupplierAdjustmentInput,
  SupplierListInput,
  SupplierPaymentInput,
  SupplierPurchaseInput,
  SupplierStatementInput,
  SupplierInput,
  UpdateCustomerInput,
  UpdateFabricInput,
} from "./contracts";

export interface Fabric {
  id: string;
  sku: string;
  name: string;
  construction: string;
  composition: string;
  widthInches: number;
  gsm: number;
  purchaseCostMinor: number;
  sellingRateMinor: number;
  reorderThresholdMm: number;
  stockMm: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FabricFilters {
  query: string;
  status: "all" | "active" | "inactive" | "low-stock";
}

export interface InvoiceItem {
  id: string;
  fabricId: string;
  sku: string;
  name: string;
  quantityMm: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  amountReceivedMinor: number;
  dueMinor: number;
  paymentAccount: "cash" | "bank";
  createdAt: string;
  customerId?: string;
  customerCode?: string;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  paymentTermsDays?: number;
  items: InvoiceItem[];
}

export interface SalesReturnSource {
  invoiceId: string;
  invoiceNumber: string;
  customerId?: string;
  customerCode?: string;
  customerName?: string;
  createdAt: string;
  items: Array<{
    sourceItemId: string;
    fabricId: string;
    sku: string;
    name: string;
    quantityMm: number;
    returnedQuantityMm: number;
    remainingQuantityMm: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
    costOfGoodsSoldMinor: number;
  }>;
}

export interface PurchaseReturnSource {
  purchaseId: string;
  billNumber: string;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  purchaseDate: string;
  items: Array<{
    sourceItemId: string;
    fabricId: string;
    sku: string;
    name: string;
    quantityMm: number;
    returnedQuantityMm: number;
    remainingQuantityMm: number;
    unitCostMinor: number;
    lineTotalMinor: number;
  }>;
}

export interface ReturnRecord {
  id: string;
  returnNumber: string;
  returnType: "sales_return" | "purchase_return";
  sourceId: string;
  sourceReference: string;
  partyName: string;
  settlementType: "refund" | "customer_credit" | "supplier_credit";
  totalMinor: number;
  reason: string;
  createdAt: string;
  authorizedUser: string;
  reversedAt?: string;
  reversalReason?: string;
}

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  sourceType: string;
  sourceId: string;
  reason: string;
  createdAt: string;
}

export interface ReturnData {
  sales: SalesReturnSource[];
  purchases: PurchaseReturnSource[];
  history: ReturnRecord[];
  auditLog: AuditLogEntry[];
}

export interface FabricDetails {
  fabric: Fabric;
  invoices: Invoice[];
}

export interface StockSummary {
  totalProducts: number;
  activeProducts: number;
  lowStockCount: number;
  totalStockMm: number;
  fabrics: Fabric[];
}

export interface InventoryMovement {
  id: string;
  fabricId: string;
  sku: string;
  fabricName: string;
  quantityMm: number;
  movementType: "opening" | "adjustment" | "purchase" | "sale" | "sales_return" | "purchase_return" | "return_reversal";
  reference: string;
  reason: string;
  authorizedUser: string;
  createdAt: string;
}

export interface InventoryValuation {
  fabricId: string;
  sku: string;
  name: string;
  stockQtyMm: number;
  unitCostMinor: number;
  valueMinor: number;
  reorderThresholdMm: number;
  lowStock: boolean;
}

export interface InventoryReport {
  totalStockMm: number;
  totalValuationMinor: number;
  lowStockCount: number;
  valuation: InventoryValuation[];
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  phone: string;
  address: string;
  contactName: string;
  email: string;
  active: boolean;
  outstandingMinor: number;
  purchaseCount: number;
  paymentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierPurchase {
  id: string;
  billNumber: string;
  reference: string;
  purchaseDate: string;
  totalMinor: number;
  additionalCostsMinor: number;
  additionalCostsDescription: string;
  paymentMode: "credit" | "cash" | "bank";
  paidMinor: number;
  dueMinor: number;
  createdAt: string;
  items: Array<{
    id: string;
    fabricId: string;
    sku: string;
    fabricName: string;
    quantityMm: number;
    unitCostMinor: number;
    allocatedCostMinor: number;
    lineTotalMinor: number;
  }>;
}

export interface SupplierPayment {
  id: string;
  purchaseId?: string;
  paymentNumber: string;
  account: "cash" | "bank";
  paymentMethod: string;
  amountMinor: number;
  reference: string;
  note: string;
  createdAt: string;
  reversedAt?: string;
  reversalReason?: string;
}

export interface PaymentAccount {
  code: string;
  name: string;
}

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type NormalBalance = "debit" | "credit";

export interface ChartOfAccount {
  code: string;
  name: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  isPaymentAccount: boolean;
}

export interface AccountingPeriod {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  status: "open" | "closed";
}

export interface JournalLineInput {
  accountCode: string;
  debitMinor?: number;
  creditMinor?: number;
  supplierId?: string;
  customerId?: string;
}

export interface JournalLine {
  accountCode: string;
  accountName: string;
  debitMinor: number;
  creditMinor: number;
  supplierId?: string;
  customerId?: string;
}

export interface JournalEntry {
  id: string;
  transactionType: string;
  reference: string;
  authorizedUser: string;
  createdAt: string;
  periodId?: string;
  reversalOfTransactionId?: string;
  reversedByTransactionId?: string;
  reversalReason?: string;
  lines: JournalLine[];
}

export interface TrialBalanceLine {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  normalBalance: NormalBalance;
  debitMinor: number;
  creditMinor: number;
}

export interface TrialBalance {
  asOf: string;
  lines: TrialBalanceLine[];
  totalDebitsMinor: number;
  totalCreditsMinor: number;
  isBalanced: boolean;
}

export interface GeneralLedgerLine {
  transactionId: string;
  transactionType: string;
  reference: string;
  createdAt: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

export interface GeneralLedger {
  account: ChartOfAccount;
  from: string;
  to: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  lines: GeneralLedgerLine[];
}

export interface ReconciliationCheck {
  name: string;
  expectedMinor: number;
  actualMinor: number;
  differenceMinor: number;
  isBalanced: boolean;
}

export interface AccountingReconciliation {
  checks: ReconciliationCheck[];
  isBalanced: boolean;
}

export interface ExpenseCategory {
  code: string;
  name: string;
  accountCode: string;
  accountName: string;
}

export interface Expense {
  id: string;
  expenseNumber: string;
  categoryCode: string;
  categoryName: string;
  expenseAccountCode: string;
  paymentAccountCode: string;
  paymentAccountName: string;
  amountMinor: number;
  expenseDate: string;
  description: string;
  createdAt: string;
  isReversed: boolean;
}

export interface ExpenseCategoryReportLine {
  categoryCode: string;
  categoryName: string;
  accountCode: string;
  amountMinor: number;
  expenseCount: number;
}

export interface ExpenseReport {
  from: string;
  to: string;
  categories: ExpenseCategoryReportLine[];
  totalMinor: number;
}

export type AnalyticsReportType =
  | "daily_sales"
  | "purchases"
  | "stock_summary"
  | "gross_profit"
  | "profit_loss"
  | "customer_balances"
  | "supplier_balances"
  | "trial_balance"
  | "cashbook"
  | "general_ledger";

export interface AnalyticsReportColumn {
  key: string;
  label: string;
  format: "text" | "number" | "money";
}

export interface AnalyticsReportReconciliation {
  name: string;
  expectedMinor: number;
  actualMinor: number;
  differenceMinor: number;
  isBalanced: boolean;
}

export interface AnalyticsReport {
  reportType: AnalyticsReportType;
  from: string;
  to: string;
  page: number;
  pageSize: number;
  totalRows: number;
  columns: AnalyticsReportColumn[];
  rows: Array<Record<string, string | number>>;
  totals: Record<string, number>;
  reconciliations: AnalyticsReportReconciliation[];
}

export interface SupplierStatementLine {
  transactionType: string;
  reference: string;
  createdAt: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

export interface SupplierStatement {
  supplierId: string;
  from: string;
  to: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  lines: SupplierStatementLine[];
}

export interface SupplierDetails {
  supplier: Supplier;
  purchases: SupplierPurchase[];
  payments: SupplierPayment[];
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  phone: string;
  address: string;
  creditLimitMinor: number;
  paymentTermsDays: number;
  active: boolean;
  outstandingMinor: number;
  advanceMinor: number;
  salesCount: number;
  receiptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerReceipt {
  id: string;
  receiptNumber: string;
  invoiceId?: string;
  invoiceNumber?: string;
  account: "cash" | "bank";
  paymentMethod: string;
  amountMinor: number;
  receivableMinor: number;
  advanceMinor: number;
  reference: string;
  note: string;
  createdAt: string;
  reversedAt?: string;
  reversalReason?: string;
}

export interface CustomerStatementLine {
  transactionType: string;
  reference: string;
  createdAt: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

export interface CustomerStatement {
  customerId: string;
  from: string;
  to: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  lines: CustomerStatementLine[];
}

export interface CustomerDetails {
  customer: Customer;
  sales: Invoice[];
  receipts: CustomerReceipt[];
  statement: CustomerStatement | null;
}

export interface DesktopApi {
  backups: {
    settings(): Promise<IpcResult<BackupSettings>>;
    create(input: { ownerPin: string }): Promise<IpcResult<{ path: string; createdAt: string }>>;
    chooseDestination(input: { ownerPin: string }): Promise<IpcResult<BackupSettings>>;
    setSchedule(input: { frequency: BackupFrequency; ownerPin: string }): Promise<IpcResult<BackupSettings>>;
    verify(input: { ownerPin: string }): Promise<IpcResult<BackupVerification | null>>;
    restore(input: { ownerPin: string }): Promise<IpcResult<{ restarting: boolean }>>;
  };
  returns: {
    data(input: ReturnDataInput): Promise<IpcResult<ReturnData>>;
    createSales(input: SalesReturnInput): Promise<IpcResult<ReturnRecord>>;
    createPurchase(input: PurchaseReturnInput): Promise<IpcResult<ReturnRecord>>;
    reverse(input: ReturnReversalInput): Promise<IpcResult<ReturnRecord>>;
  };
  reports: {
    run(input: AnalyticsReportInput): Promise<IpcResult<AnalyticsReport>>;
  };
  documents: {
    print(input: PrintDocumentInput): Promise<IpcResult<{ printed: boolean }>>;
  };
  fabrics: {
    list(filters?: FabricFiltersInput): Promise<IpcResult<Fabric[]>>;
    get(input: FabricIdInput): Promise<IpcResult<FabricDetails>>;
    create(input: FabricInput): Promise<IpcResult<Fabric>>;
    update(input: UpdateFabricInput): Promise<IpcResult<Fabric>>;
    setActive(input: FabricIdInput & { active: boolean }): Promise<IpcResult<Fabric>>;
  };
  stock: {
    summary(): Promise<IpcResult<StockSummary>>;
    adjust(input: StockAdjustmentInput): Promise<IpcResult<Fabric>>;
  };
  inventory: {
    report(): Promise<IpcResult<InventoryReport>>;
    movements(): Promise<IpcResult<InventoryMovement[]>>;
    opening(input: OpeningStockInput): Promise<IpcResult<Fabric>>;
  };
  auth: {
    pinStatus(): Promise<IpcResult<{ configured: boolean }>>;
    setPin(input: { pin: string; confirmation: string }): Promise<IpcResult<{ configured: boolean }>>;
  };
  suppliers: {
    list(input?: SupplierListInput): Promise<IpcResult<Supplier[]>>;
    get(input: { id: string }): Promise<IpcResult<SupplierDetails>>;
    create(input: SupplierInput): Promise<IpcResult<Supplier>>;
    update(input: import("./contracts").UpdateSupplierInput): Promise<IpcResult<Supplier>>;
    receive(input: SupplierPurchaseInput): Promise<IpcResult<SupplierDetails>>;
    pay(input: SupplierPaymentInput): Promise<IpcResult<SupplierDetails>>;
    reversePayment(input: import("./contracts").SupplierPaymentReversalInput): Promise<IpcResult<SupplierDetails>>;
    adjust(input: SupplierAdjustmentInput): Promise<IpcResult<SupplierDetails>>;
    statement(input: SupplierStatementInput): Promise<IpcResult<SupplierStatement>>;
    reconcile(): Promise<IpcResult<{ controlMinor: number; subledgerMinor: number; differenceMinor: number }>>;
  };
  customers: {
    list(input?: CustomerListInput): Promise<IpcResult<Customer[]>>;
    get(input: { id: string }): Promise<IpcResult<CustomerDetails>>;
    create(input: CustomerInput): Promise<IpcResult<Customer>>;
    update(input: UpdateCustomerInput): Promise<IpcResult<Customer>>;
    receive(input: CustomerReceiptInput): Promise<IpcResult<CustomerDetails>>;
    reverseReceipt(input: import("./contracts").CustomerReceiptReversalInput): Promise<IpcResult<CustomerDetails>>;
    paymentAccounts(): Promise<IpcResult<PaymentAccount[]>>;
    statement(input: CustomerStatementInput): Promise<IpcResult<CustomerStatement>>;
  };
  invoices: {
    list(): Promise<IpcResult<Invoice[]>>;
    create(input: CreateInvoiceInput): Promise<IpcResult<Invoice>>;
  };
  accounting: {
    accounts(): Promise<IpcResult<ChartOfAccount[]>>;
    createAccount(input: AccountingCreateAccountInput): Promise<IpcResult<ChartOfAccount>>;
    updateAccount(input: AccountingUpdateAccountInput): Promise<IpcResult<ChartOfAccount>>;
    periods(): Promise<IpcResult<AccountingPeriod[]>>;
    closePeriod(input: AccountingClosePeriodInput): Promise<IpcResult<AccountingPeriod>>;
    trialBalance(input: AccountingTrialBalanceInput): Promise<IpcResult<TrialBalance>>;
    generalLedger(input: AccountingGeneralLedgerInput): Promise<IpcResult<GeneralLedger>>;
    entries(input?: AccountingEntryListInput): Promise<IpcResult<JournalEntry[]>>;
    entry(input: { id: string }): Promise<IpcResult<JournalEntry>>;
    postEntry(input: AccountingManualEntryInput): Promise<IpcResult<JournalEntry>>;
    openingBalances(input: AccountingOpeningBalancesInput): Promise<IpcResult<JournalEntry>>;
    reverseEntry(input: AccountingEntryReversalInput): Promise<IpcResult<JournalEntry>>;
    reconcile(): Promise<IpcResult<AccountingReconciliation>>;
  };
  expenses: {
    categories(): Promise<IpcResult<ExpenseCategory[]>>;
    addCategory(input: ExpenseCategoryInput): Promise<IpcResult<ExpenseCategory>>;
    record(input: ExpenseInput): Promise<IpcResult<Expense>>;
    list(input: ExpenseRangeInput): Promise<IpcResult<Expense[]>>;
    report(input: ExpenseRangeInput): Promise<IpcResult<ExpenseReport>>;
  };
}

export type BackupFrequency = "disabled" | "daily" | "weekly";

export interface BackupSettings {
  destinationDirectory: string;
  frequency: BackupFrequency;
  lastBackupAt: string | null;
  nextBackupAt: string | null;
  lastError: string | null;
}

export interface BackupVerification {
  path: string;
  integrity: "ok";
  foreignKeyViolations: number;
  migrationCount: number;
}

declare global {
  interface Window {
    electronAPI?: DesktopApi;
  }
}
