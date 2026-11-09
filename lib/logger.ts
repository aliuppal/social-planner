import pino from "pino";

/**
 * Structured JSON logs. Redacts anything that could carry a secret or a full caption.
 * Never pass raw request headers or Instagram responses without picking fields first.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { app: "social-planner" },
  redact: {
    paths: [
      "*.accessToken",
      "*.access_token",
      "*.token",
      "*.apiKey",
      "*.api_key",
      "*.key",
      "*.secret",
      "*.password",
      "*.authorization",
      "*.Authorization",
      "headers.authorization",
      "*.caption",
      "*.firstComment",
      "*.accessTokenEnc",
      "*.secretEnc",
    ],
    censor: "[redacted]",
  },
});

export type Logger = pino.Logger;

/** Strip query strings (Graph API URLs carry access_token) and clip long messages before logging/storing. */
export function sanitizeError(err: unknown, max = 500): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/access_token=[^&\s"]+/gi, "access_token=[redacted]")
    .replace(/sp_live_[A-Za-z0-9_-]+/g, "sp_live_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, max);
}
