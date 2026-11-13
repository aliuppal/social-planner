"use server";

import { del } from "@vercel/blob";
import { unstable_rethrow } from "next/navigation";
import { userCtx } from "@/lib/auth/session";
import { toAppError } from "@/lib/errors";
import type { Ctx } from "@/lib/services/context";
import * as apiClients from "@/lib/services/api-clients";
import * as brands from "@/lib/services/brands";
import * as calendars from "@/lib/services/calendars";
import * as media from "@/lib/services/media";
import * as posts from "@/lib/services/posts";
import { zonedToUtc } from "@/lib/time";
import type { CreateBrandInput } from "@/lib/schemas/brand";
import type { Scope } from "@/lib/auth/guard";

/**
 * Server actions behind the web UI. Each one runs a service as the signed-in user, so the
 * same validation, permissions and audit trail apply as for MCP. Errors come back as data.
 */
export type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string; code?: string; details?: { field?: string; message: string }[] };

async function run<T>(fn: (ctx: Ctx) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const ctx = await userCtx();
    return { ok: true, data: await fn(ctx) };
  } catch (err) {
    unstable_rethrow(err); // let redirect()/notFound() through
    const e = toAppError(err);
    return { ok: false, error: e.opts.hint ? `${e.message} ${e.opts.hint}` : e.message, code: e.code, details: e.opts.details };
  }
}

/** "2026-11-12T17:00" in the brand's timezone → ISO UTC. */
function localToIso(tz: string, wall: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) throw new Error("Pick a date and time");
  return zonedToUtc(tz, +m[1], +m[2], +m[3], +m[4], +m[5]).toISOString();
}

// ---------- Posts ----------

export async function createPostAction(input: { brandId: string; type: "image" | "carousel" | "reel"; caption?: string; local?: string; calendarIds?: string[] }) {
  return run(async (ctx) => {
    const brand = await brands.getAccessibleBrand(ctx, input.brandId);
    const p = await posts.createPost(ctx, {
      brandId: brand.id,
      type: input.type,
      caption: input.caption ?? "",
      scheduledAt: input.local ? localToIso(brand.timezone, input.local) : undefined,
      calendarIds: input.calendarIds ?? [],
    });
    return { id: p.id };
  });
}

export async function updatePostAction(input: Parameters<typeof posts.updatePost>[1] & { local?: string | null }) {
  return run(async (ctx) => {
    const { local, ...rest } = input;
    if (local !== undefined) {
      const p = await posts.getPost(ctx, input.postId);
      rest.scheduledAt = local ? localToIso(p.brand.timezone, local) : null;
    }
    return posts.updatePost(ctx, rest);
  });
}

type Op = "submit" | "approve" | "reject" | "cancel" | "publishNow" | "retry" | "comment";
export async function postOpAction(op: Op, input: { postId: string; comment?: string; version?: number }) {
  return run(async (ctx): Promise<unknown> => {
    switch (op) {
      case "submit":
        return posts.submitForApproval(ctx, input);
      case "approve":
        return posts.approvePost(ctx, input);
      case "reject":
        return posts.rejectPost(ctx, input);
      case "cancel":
        return posts.cancelPost(ctx, input);
      case "publishNow":
        return posts.publishNow(ctx, input);
      case "retry":
        return posts.retryFailedPost(ctx, input);
      case "comment":
        return posts.addComment(ctx, { postId: input.postId, comment: input.comment ?? "" });
    }
  });
}

/** Schedule (or reschedule) at a brand-local time, or at the next free slot. */
export async function scheduleAction(input: { postId: string; version?: number; local?: string; nextFreeSlot?: boolean }) {
  return run(async (ctx) => {
    const p = await posts.getPost(ctx, input.postId);
    const args = { postId: input.postId, version: input.version, ...(input.nextFreeSlot ? { nextFreeSlot: true } : { scheduledAt: localToIso(p.brand.timezone, input.local ?? "") }) };
    return p.status === "scheduled" ? posts.reschedulePost(ctx, args) : posts.schedulePost(ctx, args);
  });
}

/** Calendar drag: scheduled posts are rescheduled; earlier stages just move their planned time. */
export async function movePostAction(input: { postId: string; version: number; wall: string }) {
  return run(async (ctx) => {
    const p = await posts.getPost(ctx, input.postId);
    const iso = localToIso(p.brand.timezone, input.wall);
    if (p.status === "scheduled") return posts.reschedulePost(ctx, { postId: p.id, version: input.version, scheduledAt: iso });
    return posts.updatePost(ctx, { postId: p.id, version: input.version, scheduledAt: iso });
  });
}

export async function addMediaUrlAction(input: { postId: string; url: string; altText?: string; version?: number }) {
  return run((ctx) => media.addMedia(ctx, input));
}

/** After a browser upload to Blob: import it (measured + converted to JPEG), then delete the raw upload. */
export async function addUploadedMediaAction(input: { postId: string; blobUrl: string; altText?: string }) {
  return run(async (ctx) => {
    const r = await media.addMedia(ctx, { postId: input.postId, url: input.blobUrl, altText: input.altText });
    if (process.env.BLOB_READ_WRITE_TOKEN && new URL(input.blobUrl).pathname.startsWith("/uploads/")) await del(input.blobUrl).catch(() => undefined);
    return r;
  });
}

export async function removeMediaAction(input: { postId: string; mediaId: string }) {
  return run((ctx) => media.removeMedia(ctx, input));
}

export async function reorderMediaAction(input: { postId: string; mediaIds: string[] }) {
  return run((ctx) => media.reorderMedia(ctx, input));
}

// ---------- Brands & calendars ----------

export async function createBrandAction(input: CreateBrandInput) {
  return run((ctx) => brands.createBrand(ctx, input));
}

export async function updateBrandAction(input: Parameters<typeof brands.updateBrand>[1]) {
  return run((ctx) => brands.updateBrand(ctx, input));
}

export async function updateGuidelinesAction(input: Parameters<typeof brands.updateBrandGuidelines>[1]) {
  return run((ctx) => brands.updateBrandGuidelines(ctx, input));
}

export async function createCalendarAction(input: Parameters<typeof calendars.createCalendar>[1]) {
  return run((ctx) => calendars.createCalendar(ctx, input));
}

export async function updateCalendarAction(input: Parameters<typeof calendars.updateCalendar>[1]) {
  return run((ctx) => calendars.updateCalendar(ctx, input));
}

// ---------- API clients (owner) ----------

export async function createApiClientAction(input: { name: string; source: "hermes" | "inqi" | "api"; scopes: Scope[]; brandIds: string[] | "all" }) {
  return run((ctx) => apiClients.createApiClient(ctx, input));
}

export async function rotateApiKeyAction(clientId: string) {
  return run((ctx) => apiClients.rotateKey(ctx, clientId));
}

export async function revokeApiClientAction(clientId: string) {
  return run((ctx) => apiClients.revokeApiClient(ctx, clientId));
}
