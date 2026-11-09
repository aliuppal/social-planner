import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx, Tx } from "@/lib/db";
import { postMedia, posts, type Brand, type Post, type PostMedia } from "@/lib/db/schema";
import { assertCan } from "@/lib/auth/guard";
import { AppError, notFound, parse, type ErrorDetail } from "@/lib/errors";
import { IG_LIMITS } from "@/lib/instagram/limits";
import { id } from "@/lib/schemas/post";
import type { Ctx } from "./context";
import { getAccessibleBrand } from "./brands";
import { assertVersion, lockPost, recordEvent, reapproveIfContentChanged } from "./post-status";
import { syncPublishJob } from "./publish-queue";

const LOCKED_STATUSES = ["publishing", "published", "cancelled"] as const;

// ---------- Caption ----------

/** Caption exactly as it will be sent to Instagram: caption + blank line + hashtags. */
export function composeCaption(p: Pick<Post, "caption" | "hashtags">): string {
  const tags = p.hashtags.filter((t) => !p.caption.includes(t));
  return [p.caption.trim(), tags.join(" ")].filter(Boolean).join("\n\n");
}

const countMatches = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// ---------- Validation (pure) ----------

type MediaLike = Pick<PostMedia, "mimeType" | "width" | "height" | "sizeBytes" | "durationMs" | "altText">;

/**
 * Check a post against the documented Instagram limits (lib/instagram/limits.ts).
 * Returns every problem at once so an agent can fix them in one go.
 */
export function validateForPublishing(post: Pick<Post, "type" | "caption" | "hashtags">, media: MediaLike[]): ErrorDetail[] {
  const issues: ErrorDetail[] = [];
  const L = IG_LIMITS;
  const caption = composeCaption(post);
  if (caption.length > L.caption.maxChars) issues.push({ field: "caption", message: `Caption plus hashtags is ${caption.length} characters; the limit is ${L.caption.maxChars}.` });
  const tags = countMatches(caption, /#[\p{L}\p{N}_]+/gu);
  if (tags > L.caption.maxHashtags) issues.push({ field: "hashtags", message: `${tags} hashtags; Instagram allows at most ${L.caption.maxHashtags}.` });
  const mentions = countMatches(caption, /@[\w.]+/g);
  if (mentions > L.caption.maxMentions) issues.push({ field: "caption", message: `${mentions} @mentions; Instagram allows at most ${L.caption.maxMentions}.` });

  const n = media.length;
  if (post.type === "image" && n !== 1) issues.push({ field: "media", message: `An image post needs exactly 1 image (has ${n}).` });
  if (post.type === "reel" && n !== 1) issues.push({ field: "media", message: `A reel needs exactly 1 video (has ${n}).` });
  if (post.type === "carousel" && (n < L.carousel.minItems || n > L.carousel.maxItems))
    issues.push({ field: "media", message: `A carousel needs ${L.carousel.minItems}–${L.carousel.maxItems} items (has ${n}).` });

  media.forEach((m, i) => {
    const f = `media[${i}]`;
    const isVideo = m.mimeType.startsWith("video/");
    const aspect = m.width && m.height ? m.width / m.height : undefined;
    if (post.type === "reel" || (post.type === "carousel" && isVideo)) {
      if (!L.reel.mimeTypes.includes(m.mimeType)) issues.push({ field: f, message: `Video must be MP4 or MOV (got ${m.mimeType}).` });
      if (m.sizeBytes && m.sizeBytes > L.reel.maxBytes) issues.push({ field: f, message: `Video is ${(m.sizeBytes / 1048576).toFixed(0)} MB; max is 300 MB.` });
      if (m.durationMs != null && (m.durationMs < L.reel.minDurationMs || m.durationMs > L.reel.maxDurationMs))
        issues.push({ field: f, message: `Video is ${(m.durationMs / 1000).toFixed(1)}s; it must be 3s–15min.` });
      if (aspect && (aspect < L.reel.minAspect || aspect > L.reel.maxAspect)) issues.push({ field: f, message: `Video aspect ratio ${aspect.toFixed(2)} is outside 0.01–10 (9:16 recommended).` });
      if (m.width && m.width > L.reel.maxWidth) issues.push({ field: f, message: `Video is ${m.width}px wide; max is ${L.reel.maxWidth}px.` });
      if (m.altText) issues.push({ field: `${f}.altText`, message: "Alt text is only supported on images, not videos." });
    } else {
      if (isVideo) issues.push({ field: f, message: `A ${post.type} post can't contain video.` });
      else if (!L.image.mimeTypes.includes(m.mimeType)) issues.push({ field: f, message: `Instagram only accepts JPEG images (got ${m.mimeType}). Re-upload as JPEG.` });
      if (m.sizeBytes && m.sizeBytes > L.image.maxBytes) issues.push({ field: f, message: `Image is ${(m.sizeBytes / 1048576).toFixed(1)} MB; max is 8 MB.` });
      if (aspect && (aspect < L.image.minAspect - 0.005 || aspect > L.image.maxAspect + 0.005))
        issues.push({ field: f, message: `Image aspect ratio ${m.width}x${m.height} (${aspect.toFixed(2)}) is outside 4:5 (0.8) to 1.91:1. Use e.g. 1080x1350, 1080x1080 or 1080x566.` });
      if (!m.width || !m.height) issues.push({ field: f, message: "Image dimensions unknown; re-add the media so it can be measured." });
      if (m.altText && m.altText.length > L.altText.maxChars) issues.push({ field: `${f}.altText`, message: `Alt text max is ${L.altText.maxChars} characters.` });
    }
  });
  return issues;
}

export function assertPublishable(post: Parameters<typeof validateForPublishing>[0], media: MediaLike[]) {
  const issues = validateForPublishing(post, media);
  if (issues.length) {
    throw new AppError("media_invalid", `Post isn't ready for Instagram: ${issues.map((i) => i.message).join(" ")}`, { details: issues });
  }
}

// ---------- Queries ----------

export async function listMedia(db: DbOrTx, postId: string) {
  return db.select().from(postMedia).where(eq(postMedia.postId, postId)).orderBy(asc(postMedia.position));
}

export const mediaView = (m: PostMedia) => ({
  id: m.id,
  position: m.position,
  url: m.url,
  mimeType: m.mimeType,
  width: m.width,
  height: m.height,
  sizeBytes: m.sizeBytes,
  durationMs: m.durationMs,
  altText: m.altText,
});

// ---------- Mutations ----------

async function loadEditable(ctx: Ctx, postId: string) {
  const [p] = await ctx.db.select().from(posts).where(eq(posts.id, postId));
  if (!p) throw notFound("Post", postId);
  const brand = await getAccessibleBrand(ctx, p.brandId).catch(() => {
    throw notFound("Post", postId);
  });
  assertCan(ctx.actor, "post.edit", brand);
  return { post: p, brand };
}

function assertMediaEditable(p: Post) {
  if ((LOCKED_STATUSES as readonly string[]).includes(p.status)) {
    throw new AppError("invalid_transition", `Media can't change while the post is '${p.status}'.`);
  }
}

export const addMediaSchema = z.object({
  postId: id,
  url: z.url({ protocol: /^https?$/, message: "a public http(s) URL" }),
  altText: z.string().max(IG_LIMITS.altText.maxChars).optional(),
  position: z.number().int().min(0).optional(),
  version: z.number().int().positive().optional(),
});

/** Copy media from a public URL into storage and attach it to the post. */
export async function addMedia(ctx: Ctx, input: z.input<typeof addMediaSchema>) {
  const data = parse(addMediaSchema, input);
  const { post, brand } = await loadEditable(ctx, data.postId);
  assertMediaEditable(post);
  const existing = await listMedia(ctx.db, post.id);
  if (existing.length >= IG_LIMITS.carousel.maxItems) throw new AppError("media_invalid", `A post can have at most ${IG_LIMITS.carousel.maxItems} media items.`);

  // network I/O outside the transaction
  const stored = await ctx.media.importFromUrl(data.url, { brandId: brand.id, postId: post.id });

  const result = await ctx.db.transaction(async (tx) => {
    const locked = await lockPost(tx, post.id);
    assertVersion(locked, data.version);
    assertMediaEditable(locked);
    const items = await listMedia(tx, post.id);
    const pos = Math.min(data.position ?? items.length, items.length);
    const order = items.map((m) => m.id);
    const [m] = await tx
      .insert(postMedia)
      .values({
        postId: post.id,
        position: 10_000 + items.length, // temporary slot; renumber below
        url: stored.url,
        sourceUrl: data.url,
        mimeType: stored.mimeType,
        width: stored.width,
        height: stored.height,
        sizeBytes: stored.sizeBytes,
        durationMs: stored.durationMs,
        altText: data.altText,
      })
      .returning();
    order.splice(pos, 0, m.id);
    await renumber(tx, post.id, order);
    const after = await touchAfterMediaChange(tx, ctx, locked, brand, { action: "media_added", mediaId: m.id });
    return { media: { ...m, position: pos }, before: locked, after };
  });
  await syncPublishJob(ctx, result.before, result.after);
  return { media: mediaView(result.media), post: { id: result.after.id, status: result.after.status, version: result.after.version } };
}

export async function removeMedia(ctx: Ctx, input: { postId: string; mediaId: string; version?: number }) {
  const data = parse(z.object({ postId: id, mediaId: id, version: z.number().int().positive().optional() }), input);
  const { post, brand } = await loadEditable(ctx, data.postId);
  const result = await ctx.db.transaction(async (tx) => {
    const locked = await lockPost(tx, post.id);
    assertVersion(locked, data.version);
    assertMediaEditable(locked);
    const [gone] = await tx.delete(postMedia).where(and(eq(postMedia.id, data.mediaId), eq(postMedia.postId, post.id))).returning();
    if (!gone) throw notFound("Media", data.mediaId);
    await renumber(tx, post.id, (await listMedia(tx, post.id)).map((m) => m.id));
    const after = await touchAfterMediaChange(tx, ctx, locked, brand, { action: "media_removed", mediaId: gone.id });
    return { before: locked, after };
  });
  await syncPublishJob(ctx, result.before, result.after);
  return { post: { id: result.after.id, status: result.after.status, version: result.after.version } };
}

export async function reorderMedia(ctx: Ctx, input: { postId: string; mediaIds: string[]; version?: number }) {
  const data = parse(z.object({ postId: id, mediaIds: z.array(id).min(1), version: z.number().int().positive().optional() }), input);
  const { post, brand } = await loadEditable(ctx, data.postId);
  const result = await ctx.db.transaction(async (tx) => {
    const locked = await lockPost(tx, post.id);
    assertVersion(locked, data.version);
    assertMediaEditable(locked);
    const current = await listMedia(tx, post.id);
    const want = new Set(data.mediaIds);
    if (want.size !== data.mediaIds.length || want.size !== current.length || current.some((m) => !want.has(m.id))) {
      throw new AppError("validation_error", "mediaIds must list every media id of the post exactly once.", {
        details: [{ field: "mediaIds", message: `expected these ${current.length} ids in your chosen order: ${current.map((m) => m.id).join(", ")}` }],
      });
    }
    await renumber(tx, post.id, data.mediaIds);
    const after = await touchAfterMediaChange(tx, ctx, locked, brand, { action: "media_reordered" });
    return { before: locked, after };
  });
  await syncPublishJob(ctx, result.before, result.after);
  return { post: { id: result.after.id, status: result.after.status, version: result.after.version } };
}

/** Rewrite positions 0..n-1 in the given order (via a temporary offset to respect the unique index). */
async function renumber(tx: DbOrTx, postId: string, orderedIds: string[]) {
  await tx.update(postMedia).set({ position: sql`${postMedia.position} + 100000` }).where(eq(postMedia.postId, postId));
  for (const [i, mid] of orderedIds.entries()) {
    await tx.update(postMedia).set({ position: i }).where(eq(postMedia.id, mid));
  }
}

/** Media changed: bump version, drop stale IG containers, log an edit, send approved/scheduled posts back for approval. */
async function touchAfterMediaChange(tx: Tx, ctx: Ctx, post: Post, brand: Brand, meta: Record<string, unknown>): Promise<Post> {
  const [bumped] = await tx
    .update(posts)
    .set({ version: sql`${posts.version} + 1`, updatedAt: ctx.now(), igContainerId: null, publishPolls: 0 })
    .where(eq(posts.id, post.id))
    .returning();
  await tx.update(postMedia).set({ igChildContainerId: null }).where(eq(postMedia.postId, post.id));
  await recordEvent(tx, ctx, { postId: post.id, kind: "edit", meta });
  return reapproveIfContentChanged(tx, ctx, bumped, brand);
}
