import type { IpcResult } from "./contracts";
import type {
  CreateInvoiceInput,
  FabricFiltersInput,
  FabricIdInput,
  FabricInput,
  StockAdjustmentInput,
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
  totalMinor: number;
  createdAt: string;
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
