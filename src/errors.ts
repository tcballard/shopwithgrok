import { ZodError } from "zod";

export class GrokShopError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "GrokShopError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};

export function asGrokShopError(err: unknown): GrokShopError {
  if (err instanceof GrokShopError) return err;
  if (err instanceof ZodError) {
    const message = err.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "input";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    return new GrokShopError("validation_error", message, 400);
  }
  if (err instanceof Error) return new GrokShopError("internal", err.message, 500);
  return new GrokShopError("internal", "Unknown error", 500);
}

export function errorBody(err: unknown): ErrorBody {
  const normalized = asGrokShopError(err);
  return {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  };
}
