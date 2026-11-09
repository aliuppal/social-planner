import { getDb } from "@/lib/db";
import { MockInstagramClient } from "@/lib/instagram/mock";
import { logger } from "@/lib/logger";
import { MemoryQueue, type Deps } from "@/lib/services/context";
import { BlobMediaStore } from "@/lib/storage/media-store";

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
    // Production never fake-publishes: without a connected account the publisher fails with a clear error.
    igMode: process.env.VERCEL_ENV === "production" ? "real" : "mock",
    queue: new MemoryQueue(),
    media: new BlobMediaStore({ upload: Boolean(process.env.BLOB_READ_WRITE_TOKEN) }),
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
