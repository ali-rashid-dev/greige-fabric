import type { IpcResult } from "./contracts";
import type {
  CreateInvoiceInput,
  CustomerInput,
  CustomerListInput,
  CustomerReceiptInput,
  CustomerStatementInput,
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
  items: InvoiceItem[];
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
  movementType: "opening" | "adjustment" | "purchase" | "sale";
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
  amountMinor: number;
  reference: string;
  note: string;
  createdAt: string;
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
  salesCount: number;
  receiptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerReceipt {
  id: string;
  receiptNumber: string;
  account: "cash" | "bank";
  amountMinor: number;
  reference: string;
  note: string;
  createdAt: string;
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
    statement(input: CustomerStatementInput): Promise<IpcResult<CustomerStatement>>;
  };
  invoices: {
    list(): Promise<IpcResult<Invoice[]>>;
    create(input: CreateInvoiceInput): Promise<IpcResult<Invoice>>;
  };
}

declare global {
  interface Window {
    electronAPI?: DesktopApi;
  }
}
