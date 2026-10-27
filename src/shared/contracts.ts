import { z } from "zod";
import type {
  Fabric,
  FabricDetails,
  FabricFilters,
  Invoice,
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
});

export const createInvoiceSchema = z.object({
  items: z.array(z.object({
    fabricId: z.string().uuid(),
    quantityMeters: z.number().finite().positive().max(1_000_000)
      .refine((value) => hasPrecision(value, 1000), "Use up to 3 decimal places"),
  })).min(1).max(100),
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

export type FabricFiltersInput = z.input<typeof fabricFiltersSchema>;
export type FabricInput = z.infer<typeof fabricInputSchema>;
export type UpdateFabricInput = FabricInput & { id: string };
export type FabricIdInput = z.infer<typeof fabricIdSchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export type IpcErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INSUFFICIENT_STOCK"
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
  "invoices:list": { input: undefined; output: Invoice[] };
  "invoices:create": { input: CreateInvoiceInput; output: Invoice };
}
