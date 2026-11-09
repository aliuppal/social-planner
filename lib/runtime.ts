import { getDb } from "@/lib/db";
import { MockInstagramClient } from "@/lib/instagram/mock";
import { logger } from "@/lib/logger";
import { MemoryQueue, PassthroughMediaStore, type Deps } from "@/lib/services/context";

let deps: Deps | undefined;

/**
 * App runtime dependencies. Swapped for real implementations as phases land:
 * - queue: QStash (phase 5). Until then nothing fires automatically; publish_now and the sweep still work.
 * - media: Vercel Blob (phase 3)
 * - ig: real Graph API client when INSTAGRAM_CLIENT=real (phase 5)
 */
export function getDeps(): Deps {
  if (deps) return deps;
  if (process.env.INSTAGRAM_CLIENT === "real") throw new Error("INSTAGRAM_CLIENT=real isn't available until phase 5; use mock.");
  deps = {
    db: getDb(),
    ig: new MockInstagramClient(),
    igMode: "mock",
    queue: new MemoryQueue(),
    media: new PassthroughMediaStore(),
    now: () => new Date(),
    log: logger,
  };
  return deps;
}

/** Public base URL for links in emails (invites, iCal). */
export function appUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
}
