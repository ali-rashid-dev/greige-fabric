import { ipcMain } from "electron";
import { z } from "zod";
import { channels } from "../../shared/channels";
import {
  createInvoiceSchema,
  fabricFiltersSchema,
  fabricIdSchema,
  fabricInputSchema,
  stockAdjustmentSchema,
  updateFabricSchema,
  type IpcErrorCode,
  type IpcResult,
} from "../../shared/contracts";
import { FabricService, FabricServiceError } from "../services/fabrics";
import { isTrustedSender } from "./security";

function failure<T>(code: IpcErrorCode, message: string): IpcResult<T> {
  return { ok: false, error: { code, message } };
}

function registerHandler<Input, Output>(
  channel: string,
  service: FabricService,
  developmentUrl: string | undefined,
  productionFileUrl: string,
  schema: z.ZodType<Input>,
  handler: (service: FabricService, input: Input) => Output,
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
      return { ok: true, data: handler(service, parsed.data) };
    } catch (error) {
      if (error instanceof FabricServiceError) return failure(error.code, error.message);
      if (error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return failure("CONFLICT", "That SKU is already in use.");
      }
      console.error(`IPC request failed on ${channel}.`, error);
      return failure("INTERNAL", "The request could not be completed.");
    }
  });
}

export function registerIpcHandlers(
  service: FabricService,
  developmentUrl: string | undefined,
  productionFileUrl: string,
): void {
  registerHandler(
    channels.listFabrics, service, developmentUrl, productionFileUrl,
    fabricFiltersSchema, (fabrics, input) => fabrics.list(input),
  );
  registerHandler(
    channels.getFabric, service, developmentUrl, productionFileUrl,
    fabricIdSchema, (fabrics, input) => fabrics.get(input.id),
  );
  registerHandler(
    channels.createFabric, service, developmentUrl, productionFileUrl,
    fabricInputSchema, (fabrics, input) => fabrics.create(input),
  );
  registerHandler(
    channels.updateFabric, service, developmentUrl, productionFileUrl,
    updateFabricSchema, (fabrics, input) => fabrics.update(input),
  );
  registerHandler(
    channels.setFabricActive, service, developmentUrl, productionFileUrl,
    fabricIdSchema.extend({ active: z.boolean() }),
    (fabrics, input) => fabrics.setActive(input.id, input.active),
  );
  registerHandler(
    channels.stockSummary, service, developmentUrl, productionFileUrl,
    z.undefined(), (fabrics) => fabrics.stockSummary(),
  );
  registerHandler(
    channels.adjustStock, service, developmentUrl, productionFileUrl,
    stockAdjustmentSchema, (fabrics, input) => fabrics.adjustStock(input),
  );
  registerHandler(
    channels.listInvoices, service, developmentUrl, productionFileUrl,
    z.undefined(), (fabrics) => fabrics.listInvoices(),
  );
  registerHandler(
    channels.createInvoice, service, developmentUrl, productionFileUrl,
    createInvoiceSchema, (fabrics, input) => fabrics.createInvoice(input),
  );
}
