import { getDb } from "@/lib/db";
import { GraphInstagramClient } from "@/lib/instagram/graph";
import { MockInstagramClient } from "@/lib/instagram/mock";
import { logger } from "@/lib/logger";
import { QStashQueue } from "@/lib/queue/qstash";
import { MemoryQueue, type Deps } from "@/lib/services/context";
import { BlobMediaStore } from "@/lib/storage/media-store";

let deps: Deps | undefined;

/**
 * App runtime dependencies:
 * - ig: real Graph API when INSTAGRAM_CLIENT=real, otherwise the in-memory mock (dev)
 * - igMode "real" in production: a brand without a connected account never fake-publishes
 * - queue: QStash exact-time triggers when QSTASH_TOKEN is set (needs a public APP_URL), else in-memory
 * - media: Vercel Blob when BLOB_READ_WRITE_TOKEN is set
 */
export function getDeps(): Deps {
  if (deps) return deps;
  const real = process.env.INSTAGRAM_CLIENT === "real";
  deps = {
    db: getDb(),
    ig: real ? new GraphInstagramClient() : new MockInstagramClient(),
    igMode: real || process.env.VERCEL_ENV === "production" ? "real" : "mock",
    queue: process.env.QSTASH_TOKEN ? new QStashQueue(process.env.QSTASH_TOKEN, appUrl()) : new MemoryQueue(),
    media: new BlobMediaStore({ upload: Boolean(process.env.BLOB_READ_WRITE_TOKEN) }),
    now: () => new Date(),
    log: logger,
  };
  return deps;
}

/** Public base URL for links in emails, OAuth redirects and QStash callbacks. */
export function appUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
}
