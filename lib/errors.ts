import { z, ZodError } from "zod";

export type ErrorCode =
  | "validation_error"
  | "not_found"
  | "forbidden"
  | "unauthorized"
  | "invalid_transition"
  | "version_conflict"
  | "media_invalid"
  | "no_free_slot"
  | "conflict"
  | "rate_limited"
  | "instagram_error"
  | "internal";

const HTTP: Record<ErrorCode, number> = {
  validation_error: 400,
  media_invalid: 422,
  invalid_transition: 409,
  version_conflict: 409,
  conflict: 409,
  no_free_slot: 409,
  not_found: 404,
  forbidden: 403,
  unauthorized: 401,
  rate_limited: 429,
  instagram_error: 502,
  internal: 500,
};

export type ErrorDetail = { field?: string; message: string };

/** Error shape returned to UI, REST and MCP. Messages are written so an agent can fix its call. */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public opts: { details?: ErrorDetail[]; hint?: string; data?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "AppError";
  }
  get status() {
    return HTTP[this.code];
  }
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.opts.details?.length ? { details: this.opts.details } : {}),
        ...(this.opts.hint ? { hint: this.opts.hint } : {}),
        ...(this.opts.data ? { data: this.opts.data } : {}),
      },
    };
  }
}

export const notFound = (what: string, id?: string) =>
  new AppError("not_found", `${what}${id ? ` ${id}` : ""} not found, or you don't have access to it`);

export const forbidden = (message: string, hint?: string) => new AppError("forbidden", message, { hint });

export function fromZod(err: ZodError): AppError {
  const details = err.issues.map((i) => ({ field: i.path.join(".") || undefined, message: i.message }));
  return new AppError("validation_error", `Invalid input: ${details.map((d) => (d.field ? `${d.field}: ${d.message}` : d.message)).join("; ")}`, {
    details,
  });
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return fromZod(err);
  return new AppError("internal", "Unexpected server error");
}

/** Parse with a Zod schema, throwing an AppError with field-level details. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw fromZod(r.error);
  return r.data;
}
