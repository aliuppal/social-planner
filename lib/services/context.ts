import type { Db } from "@/lib/db";
import type { Actor } from "@/lib/auth/guard";
import type { InstagramClient } from "@/lib/instagram/client";
import type { Logger } from "@/lib/logger";

// ---------- Job queue (QStash in production, in-memory in tests/dev) ----------

export interface JobQueue {
  /** Deliver a publish job for `postId` at `at` (exact minute). Returns the queue message id. */
  enqueuePublish(postId: string, at: Date): Promise<string>;
  /** Cancel a pending message. Must not throw if it was already delivered or deleted. */
  cancel(messageId: string): Promise<void>;
}

export class MemoryQueue implements JobQueue {
  jobs = new Map<string, { postId: string; at: Date }>();
  cancelled: string[] = [];
  private seq = 0;
  async enqueuePublish(postId: string, at: Date) {
    const id = `msg_${++this.seq}`;
    this.jobs.set(id, { postId, at });
    return id;
  }
  async cancel(messageId: string) {
    if (this.jobs.delete(messageId)) this.cancelled.push(messageId);
  }
  pendingFor(postId: string) {
    return [...this.jobs.entries()].filter(([, j]) => j.postId === postId);
  }
}

// ---------- Media store (Vercel Blob in production) ----------

export type StoredMedia = { url: string; mimeType: string; width?: number; height?: number; sizeBytes?: number; durationMs?: number };

export interface MediaStore {
  /** Copy a public URL into our storage and return a public HTTPS URL + probed metadata. */
  importFromUrl(sourceUrl: string, opts: { brandId: string; postId: string }): Promise<StoredMedia>;
}

/** Dev/test store: keeps the source URL and guesses the mime type from the extension. */
export class PassthroughMediaStore implements MediaStore {
  constructor(private meta: Partial<StoredMedia> = { width: 1080, height: 1350, sizeBytes: 400_000 }) {}
  async importFromUrl(sourceUrl: string): Promise<StoredMedia> {
    const ext = new URL(sourceUrl).pathname.split(".").pop()?.toLowerCase();
    const mimeType = ext === "mp4" ? "video/mp4" : ext === "mov" ? "video/quicktime" : ext === "png" ? "image/png" : "image/jpeg";
    return { url: sourceUrl, mimeType, ...this.meta };
  }
}

// ---------- Service context ----------

export type Deps = {
  db: Db;
  ig: InstagramClient;
  /** "mock": brands without a connected account can still "publish" (dev/tests). "real": they fail clearly. */
  igMode: "mock" | "real";
  queue: JobQueue;
  media: MediaStore;
  now: () => Date;
  log: Logger;
};

/** Every service function takes a Ctx: who is acting + the swappable dependencies. */
export type Ctx = Deps & { actor: Actor };

export function withActor(deps: Deps, actor: Actor): Ctx {
  return { ...deps, actor };
}
