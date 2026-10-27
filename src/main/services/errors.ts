export type ServiceErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "INSUFFICIENT_STOCK"
  | "AUTHORIZATION"
  | "VALIDATION";

export class FabricServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FabricServiceError";
  }
}
