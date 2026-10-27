import { z } from "zod";
import type {
  Fabric,
  FabricDetails,
  FabricFilters,
  Customer,
  CustomerDetails,
  CustomerStatement,
  Invoice,
  InventoryMovement,
  InventoryReport,
  PaymentAccount,
  Supplier,
  SupplierDetails,
  SupplierStatement,
  StockSummary,
} from "./types";

function hasPrecision(value: number, scale: number): boolean {
  return Math.abs(value * scale - Math.round(value * scale)) < 1e-8;
}

export const fabricFiltersSchema = z.object({
  query: z.string().trim().max(200).default(""),
  status: z.enum(["all", "active", "inactive", "low-stock"]).default("active"),
});

export const fabricInputSchema = z.object({
  sku: z.string().trim().min(1, "SKU is required").max(40)
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1, "Fabric name is required").max(120),
  construction: z.string().trim().min(1, "Construction is required").max(80),
  composition: z.string().trim().min(1, "Composition is required").max(120),
  widthInches: z.number().finite().positive().max(500),
  gsm: z.number().finite().positive().max(5000),
  purchaseCost: z.number().finite().nonnegative().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  sellingRate: z.number().finite().positive().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  reorderThresholdMeters: z.number().finite().nonnegative().max(1_000_000)
    .refine((value) => hasPrecision(value, 1000), "Use up to 3 decimal places"),
});

export const fabricIdSchema = z.object({ id: z.string().uuid() });

export const updateFabricSchema = fabricInputSchema.extend({
  id: z.string().uuid(),
});

export const stockAdjustmentSchema = z.object({
  fabricId: z.string().uuid(),
  direction: z.enum(["add", "remove"]),
  quantityMeters: z.number().finite().positive().max(1_000_000)
    .refine((value) => hasPrecision(value, 1000), "Use up to 3 decimal places"),
  reason: z.string().trim().min(1, "A stock adjustment reason is required").max(160),
  ownerPin: z.string().min(6).max(64),
});

export const openingStockSchema = z.object({
  fabricId: z.string().uuid(),
  quantityMeters: z.number().finite().positive().max(1_000_000)
    .refine((value) => hasPrecision(value, 1000), "Use up to 3 decimal places"),
  unitCost: z.number().finite().nonnegative().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  reference: z.string().trim().min(1, "A reference is required").max(100),
  reason: z.string().trim().min(1, "A reason is required").max(160),
  ownerPin: z.string().min(6).max(64),
});

export const createInvoiceSchema = z.object({
  customerId: z.string().uuid().optional(),
  items: z.array(z.object({
    fabricId: z.string().uuid(),
    quantityMeters: z.number().finite().positive().max(1_000_000)
      .refine((value) => hasPrecision(value, 1000), "Use up to 3 decimal places"),
    unitRate: z.number().finite().positive().max(1_000_000_000)
      .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places")
      .optional(),
  })).min(1).max(100),
  discount: z.number().finite().nonnegative().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places")
    .optional(),
  receivedAmount: z.number().finite().nonnegative().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places")
    .optional(),
  paymentAccount: z.enum(["cash", "bank"]).optional(),
}).superRefine(({ items }, context) => {
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.fabricId)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "fabricId"],
        message: "A fabric can appear only once on an invoice.",
      });
    }
    ids.add(item.fabricId);
  }
});

const supplierFields = {
  code: z.string().trim().min(1, "Supplier code is required").max(40)
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1, "Supplier name is required").max(120),
  phone: z.string().trim().min(1, "Phone number is required").max(40),
  address: z.string().trim().max(240).default(""),
  contactName: z.string().trim().max(120).default(""),
  email: z.string().trim().max(160).default("")
    .refine((value) => !value || z.email().safeParse(value).success, "Enter a valid email address"),
};

export const supplierInputSchema = z.object({
  ...supplierFields,
  openingBalance: z.number().finite().nonnegative().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  ownerPin: z.string().optional(),
}).superRefine(({ openingBalance, ownerPin }, context) => {
  if (openingBalance > 0 && !/^\d{6,64}$/.test(ownerPin ?? "")) {
    context.addIssue({
      code: "custom",
      path: ["ownerPin"],
      message: "A valid owner PIN is required to record an opening payable balance.",
    });
  }
});

export const updateSupplierSchema = z.object({
  ...supplierFields,
  id: z.string().uuid(),
});

export const supplierIdSchema = z.object({ id: z.string().uuid() });

export const supplierPurchaseSchema = z.object({
  supplierId: z.string().uuid(),
  billNumber: z.string().trim().min(1, "Bill number is required").max(80),
  reference: z.string().trim().max(100).default(""),
  purchaseDate: z.string().date(),
  additionalCosts: z.number().finite().nonnegative().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  additionalCostsDescription: z.string().trim().max(120).default(""),
  paymentMode: z.enum(["credit", "cash", "bank"]),
  amountPaid: z.number().finite().nonnegative().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  paymentAccount: z.enum(["cash", "bank"]).default("cash"),
  items: z.array(z.object({
    fabricId: z.string().uuid(),
    quantityMeters: z.number().finite().positive().max(1_000_000)
      .refine((value) => hasPrecision(value, 1000), "Use up to 3 decimal places"),
    unitCost: z.number().finite().nonnegative().max(1_000_000_000)
      .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  })).min(1).max(100),
}).superRefine(({ items }, context) => {
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.fabricId)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "fabricId"],
        message: "A fabric can appear only once on a purchase.",
      });
    }
    ids.add(item.fabricId);
  }
}).superRefine(({ paymentMode, amountPaid }, context) => {
  if (paymentMode !== "credit" && amountPaid <= 0) {
    context.addIssue({
      code: "custom",
      path: ["amountPaid"],
      message: "Cash and bank purchases must be paid in full when received.",
    });
  }
});

export const supplierPaymentSchema = z.object({
  supplierId: z.string().uuid(),
  purchaseId: z.string().uuid().optional(),
  amount: z.number().finite().positive().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  account: z.enum(["cash", "bank"]).optional(),
  accountCode: z.string().trim().min(1).max(40).optional(),
  reference: z.string().trim().max(100).default(""),
  note: z.string().trim().max(160).default(""),
}).refine((input) => input.account !== undefined || input.accountCode !== undefined, {
  path: ["accountCode"],
  message: "Choose a configured payment account.",
});

export const supplierPaymentReversalSchema = z.object({
  paymentId: z.string().uuid(),
  reason: z.string().trim().min(1, "A reversal reason is required").max(160),
});

export const supplierAdjustmentSchema = z.object({
  supplierId: z.string().uuid(),
  direction: z.enum(["increase", "decrease"]),
  amount: z.number().finite().positive().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  reason: z.string().trim().min(1, "An adjustment reason is required").max(160),
  ownerPin: z.string().min(6).max(64),
});

export const supplierStatementSchema = z.object({
  supplierId: z.string().uuid(),
  from: z.string().date(),
  to: z.string().date(),
}).refine(({ from, to }) => from <= to, {
  path: ["to"],
  message: "End date must be on or after start date.",
});

export const supplierListSchema = z.object({
  query: z.string().trim().max(200).default(""),
  includeInactive: z.boolean().default(false),
});

const customerFields = {
  code: z.string().trim().min(1, "Customer code is required").max(40)
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1, "Customer name is required").max(120),
  phone: z.string().trim().max(40).default(""),
  address: z.string().trim().max(240).default(""),
  creditLimit: z.number().finite().nonnegative().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  paymentTermsDays: z.number().int().min(0).max(3650),
};

export const customerInputSchema = z.object({
  ...customerFields,
  openingBalance: z.number().finite().nonnegative().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  ownerPin: z.string().optional(),
}).superRefine(({ openingBalance, ownerPin }, context) => {
  if (openingBalance > 0 && !/^\d{6,64}$/.test(ownerPin ?? "")) {
    context.addIssue({
      code: "custom",
      path: ["ownerPin"],
      message: "A valid owner PIN is required to record an opening receivable.",
    });
  }
});

export const updateCustomerSchema = z.object({
  ...customerFields,
  id: z.string().uuid(),
});

export const customerListSchema = z.object({
  query: z.string().trim().max(200).default(""),
  includeInactive: z.boolean().default(false),
});

export const customerReceiptSchema = z.object({
  customerId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
  amount: z.number().finite().positive().max(1_000_000_000)
    .refine((value) => hasPrecision(value, 100), "Use up to 2 decimal places"),
  account: z.enum(["cash", "bank"]).optional(),
  accountCode: z.string().trim().min(1).max(40).optional(),
  reference: z.string().trim().max(100).default(""),
  note: z.string().trim().max(160).default(""),
}).refine((input) => input.account !== undefined || input.accountCode !== undefined, {
  path: ["accountCode"],
  message: "Choose a configured payment account.",
});

export const customerReceiptReversalSchema = z.object({
  receiptId: z.string().uuid(),
  reason: z.string().trim().min(1, "A reversal reason is required").max(160),
});

export const customerStatementSchema = z.object({
  customerId: z.string().uuid(),
  from: z.string().date(),
  to: z.string().date(),
}).refine(({ from, to }) => from <= to, {
  path: ["to"],
  message: "End date must be on or after start date.",
});

export const pinSchema = z.object({
  pin: z.string().min(6, "PIN must be at least 6 characters").max(64)
    .regex(/^\d+$/, "PIN must contain digits only"),
});

export const pinSetupSchema = pinSchema.extend({
  confirmation: z.string(),
}).refine(({ pin, confirmation }) => pin === confirmation, {
  path: ["confirmation"],
  message: "PIN confirmation does not match.",
});

export type FabricFiltersInput = z.input<typeof fabricFiltersSchema>;
export type FabricInput = z.infer<typeof fabricInputSchema>;
export type UpdateFabricInput = FabricInput & { id: string };
export type FabricIdInput = z.infer<typeof fabricIdSchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type OpeningStockInput = z.infer<typeof openingStockSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type SupplierInput = z.infer<typeof supplierInputSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type SupplierPurchaseInput = z.infer<typeof supplierPurchaseSchema>;
export type SupplierPaymentInput = z.infer<typeof supplierPaymentSchema>;
export type SupplierPaymentReversalInput = z.infer<typeof supplierPaymentReversalSchema>;
export type SupplierAdjustmentInput = z.infer<typeof supplierAdjustmentSchema>;
export type SupplierStatementInput = z.infer<typeof supplierStatementSchema>;
export type SupplierListInput = z.input<typeof supplierListSchema>;
export type CustomerInput = z.infer<typeof customerInputSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type CustomerListInput = z.input<typeof customerListSchema>;
export type CustomerReceiptInput = z.infer<typeof customerReceiptSchema>;
export type CustomerReceiptReversalInput = z.infer<typeof customerReceiptReversalSchema>;
export type CustomerStatementInput = z.infer<typeof customerStatementSchema>;

export type IpcErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INSUFFICIENT_STOCK"
  | "AUTHORIZATION"
  | "INTERNAL";

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: IpcErrorCode; message: string } };

export interface IpcContract {
  "fabrics:list": { input: FabricFilters; output: Fabric[] };
  "fabrics:get": { input: FabricIdInput; output: FabricDetails };
  "fabrics:create": { input: FabricInput; output: Fabric };
  "fabrics:update": { input: UpdateFabricInput; output: Fabric };
  "fabrics:set-active": { input: FabricIdInput & { active: boolean }; output: Fabric };
  "stock:summary": { input: undefined; output: StockSummary };
  "stock:adjust": { input: StockAdjustmentInput; output: Fabric };
  "inventory:report": { input: undefined; output: InventoryReport };
  "inventory:movements": { input: undefined; output: InventoryMovement[] };
  "inventory:opening": { input: OpeningStockInput; output: Fabric };
  "invoices:list": { input: undefined; output: Invoice[] };
  "invoices:create": { input: CreateInvoiceInput; output: Invoice };
  "customers:list": { input: CustomerListInput; output: Customer[] };
  "customers:get": { input: { id: string }; output: CustomerDetails };
  "customers:create": { input: CustomerInput; output: Customer };
  "customers:update": { input: UpdateCustomerInput; output: Customer };
  "customers:receive": { input: CustomerReceiptInput; output: CustomerDetails };
  "customers:reverse-receipt": { input: CustomerReceiptReversalInput; output: CustomerDetails };
  "customers:payment-accounts": { input: undefined; output: PaymentAccount[] };
  "customers:statement": { input: CustomerStatementInput; output: CustomerStatement };
  "auth:pin-status": { input: undefined; output: { configured: boolean } };
  "auth:set-pin": { input: z.infer<typeof pinSetupSchema>; output: { configured: boolean } };
  "suppliers:list": { input: SupplierListInput; output: Supplier[] };
  "suppliers:get": { input: z.infer<typeof supplierIdSchema>; output: SupplierDetails };
  "suppliers:create": { input: SupplierInput; output: Supplier };
  "suppliers:update": { input: UpdateSupplierInput; output: Supplier };
  "suppliers:receive": { input: SupplierPurchaseInput; output: SupplierDetails };
  "suppliers:pay": { input: SupplierPaymentInput; output: SupplierDetails };
  "suppliers:reverse-payment": { input: SupplierPaymentReversalInput; output: SupplierDetails };
  "suppliers:adjust": { input: SupplierAdjustmentInput; output: SupplierDetails };
  "suppliers:statement": { input: SupplierStatementInput; output: SupplierStatement };
  "suppliers:reconcile": { input: undefined; output: { controlMinor: number; subledgerMinor: number; differenceMinor: number } };
}
