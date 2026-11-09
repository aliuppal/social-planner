import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx, Tx } from "@/lib/db";
import { brands, calendarPosts, calendars, postEvents, postInsights, postMedia, posts, users, type Brand, type Post, type PostMedia } from "@/lib/db/schema";
import { actorSource, assertCan, brandScope, type Action } from "@/lib/auth/guard";
import { AppError, notFound, parse } from "@/lib/errors";
import { sanitizeError } from "@/lib/logger";
import { actingUserSchema, createPostSchema, id, listPostsSchema, reviewSchema, schedulePostSchema, updatePostSchema } from "@/lib/schemas/post";
import { toZonedIso } from "@/lib/time";
import type { Ctx, StoredMedia } from "./context";
import { getAccessibleBrand } from "./brands";
import { assertPublishable, listMedia, mediaView, validateForPublishing } from "./media";
import { applyTransition, assertVersion, lockPost, reapproveIfContentChanged, recordEvent } from "./post-status";
import { syncPublishJob } from "./publish-queue";
import { MIN_LEAD_MS, nextFreeSlot } from "./scheduling";
import { publishPost } from "./publisher";

// ---------- Views ----------

export function postView(p: Post, opts: { media?: PostMedia[]; timezone?: string } = {}) {
  const tz = opts.timezone;
  return {
    id: p.id,
    brandId: p.brandId,
    type: p.type,
    status: p.status,
    source: p.source,
    caption: p.caption,
    hashtags: p.hashtags,
    firstComment: p.firstComment,
    pillar: p.pillar,
    notes: p.notes,
    isAiGenerated: p.isAiGenerated,
    scheduledAt: p.scheduledAt?.toISOString() ?? null,
    scheduledAtLocal: p.scheduledAt && tz ? toZonedIso(p.scheduledAt, tz) : undefined,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    permalink: p.permalink,
    igMediaId: p.igMediaId,
    lastError: p.lastError,
    publishAttempts: p.publishAttempts,
    version: p.version,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    ...(opts.media ? { media: opts.media.map(mediaView) } : {}),
  };
}

// ---------- Helpers ----------

async function loadPost(ctx: Ctx, postId: string, action: Action): Promise<{ post: Post; brand: Brand }> {
  parse(id, postId);
  const [post] = await ctx.db.select().from(posts).where(eq(posts.id, postId));
  if (!post) throw notFound("Post", postId);
  const brand = await getAccessibleBrand(ctx, post.brandId).catch(() => {
    throw notFound("Post", postId);
  });
  assertCan(ctx.actor, action, brand);
  return { post, brand };
}

/** inqi passes the client-portal user it acts for; link to a planner user if external_user_id matches. */
async function withActingUser(ctx: Ctx, acting?: z.infer<typeof actingUserSchema>): Promise<Ctx> {
  if (!acting || ctx.actor.kind !== "api_client") return ctx;
  const [linked] = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.externalUserId, acting.id));
  return { ...ctx, actor: { ...ctx.actor, actingUser: { id: acting.id, name: acting.name ?? linked?.name, userId: linked?.id } } };
}

async function importMedia(ctx: Ctx, brandId: string, postId: string, items: { url: string; altText?: string }[]) {
  const out: (StoredMedia & { sourceUrl: string; altText?: string })[] = [];
  for (const [i, m] of items.entries()) {
    try {
      out.push({ ...(await ctx.media.importFromUrl(m.url, { brandId, postId })), sourceUrl: m.url, altText: m.altText });
    } catch (err) {
      throw new AppError("media_invalid", `Couldn't fetch media[${i}] from ${m.url}: ${sanitizeError(err, 200)}`, {
        details: [{ field: `media[${i}].url`, message: "must be a public URL that returns an image or video" }],
      });
    }
  }
  return out;
}

async function assertCustomCalendars(db: DbOrTx, brandId: string, calendarIds: string[]) {
  if (!calendarIds.length) return;
  const rows = await db
    .select({ id: calendars.id })
    .from(calendars)
    .where(and(inArray(calendars.id, calendarIds), eq(calendars.brandId, brandId), eq(calendars.kind, "custom"), isNull(calendars.archivedAt)));
  if (rows.length !== new Set(calendarIds).size) {
    const found = new Set(rows.map((r) => r.id));
    throw new AppError("validation_error", "Some calendarIds aren't active custom calendars of this brand.", {
      details: calendarIds.filter((c) => !found.has(c)).map((c) => ({ field: "calendarIds", message: `${c} not found for this brand` })),
      hint: "Call list_calendars. Every post is already on its brand calendar; calendarIds are for custom calendars only.",
    });
  }
}

function resolveTime(ctx: Ctx, iso: string): Date {
  const at = new Date(iso);
  if (at.getTime() < ctx.now().getTime() + MIN_LEAD_MS) {
    throw new AppError("validation_error", `scheduledAt ${iso} is in the past or less than a minute away.`, {
      details: [{ field: "scheduledAt", message: "must be at least 1 minute in the future" }],
      hint: "Use publish_now to post immediately.",
    });
  }
  return at;
}

const NOT_EDITABLE = ["publishing", "published", "cancelled"];
const CONTENT_FIELDS = ["type", "caption", "hashtags", "firstComment", "isAiGenerated"];

// ---------- Create ----------

type NewPostRow = typeof posts.$inferInsert;

async function prepareCreate(ctx: Ctx, input: unknown) {
  const data = parse(createPostSchema, input);
  const brand = await getAccessibleBrand(ctx, data.brandId);
  assertCan(ctx.actor, "post.create", brand);
  await assertCustomCalendars(ctx.db, brand.id, data.calendarIds);
  const postId = randomUUID();
  const media = await importMedia(ctx, brand.id, postId, data.media);
  const row: NewPostRow = {
    id: postId,
    brandId: brand.id,
    type: data.type,
    status: data.status,
    source: actorSource(ctx.actor),
    caption: data.caption,
    hashtags: data.hashtags,
    firstComment: data.firstComment ?? null,
    pillar: data.pillar ?? null,
    notes: data.notes ?? null,
    isAiGenerated: data.isAiGenerated,
    scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
    createdByUserId: ctx.actor.kind === "user" ? ctx.actor.userId : null,
    createdByApiClientId: ctx.actor.kind === "api_client" ? ctx.actor.clientId : null,
    createdAt: ctx.now(),
    updatedAt: ctx.now(),
  };
  return { brand, row, media, calendarIds: [...new Set(data.calendarIds)] };
}

async function insertPrepared(tx: Tx, ctx: Ctx, p: Awaited<ReturnType<typeof prepareCreate>>) {
  const [post] = await tx.insert(posts).values(p.row).returning();
  const media = p.media.length
    ? await tx
        .insert(postMedia)
        .values(
          p.media.map((m, i) => ({
            postId: post.id,
            position: i,
            url: m.url,
            sourceUrl: m.sourceUrl,
            mimeType: m.mimeType,
            width: m.width,
            height: m.height,
            sizeBytes: m.sizeBytes,
            durationMs: m.durationMs,
            altText: m.altText,
          })),
        )
        .returning()
    : [];
  if (p.calendarIds.length) await tx.insert(calendarPosts).values(p.calendarIds.map((calendarId) => ({ calendarId, postId: post.id })));
  await recordEvent(tx, ctx, { postId: post.id, kind: "transition", from: null, to: post.status, comment: "Created" });
  return { post, media };
}

export async function createPost(ctx: Ctx, input: z.input<typeof createPostSchema>) {
  const prepared = await prepareCreate(ctx, input);
  const { post, media } = await ctx.db.transaction((tx) => insertPrepared(tx, ctx, prepared));
  return { ...postView(post, { media, timezone: prepared.brand.timezone }), calendarIds: prepared.calendarIds, warnings: validateForPublishing(post, media) };
}

export const bulkCreateSchema = z.object({ posts: z.array(z.unknown()).min(1).max(50) });

/** All-or-nothing: every post is validated and its media fetched first; then one transaction inserts them all. */
export async function bulkCreatePosts(ctx: Ctx, input: z.input<typeof bulkCreateSchema>) {
  const { posts: items } = parse(bulkCreateSchema, input);
  const prepared: Awaited<ReturnType<typeof prepareCreate>>[] = [];
  for (const [i, item] of items.entries()) {
    try {
      prepared.push(await prepareCreate(ctx, item));
    } catch (err) {
      if (err instanceof AppError) {
        throw new AppError(err.code, `posts[${i}]: ${err.message}`, { ...err.opts, details: err.opts.details?.map((d) => ({ ...d, field: `posts[${i}]${d.field ? `.${d.field}` : ""}` })) });
      }
      throw err;
    }
  }
  const created = await ctx.db.transaction(async (tx) => {
    const out = [];
    for (const p of prepared) out.push({ ...(await insertPrepared(tx, ctx, p)), tz: p.brand.timezone });
    return out;
  });
  return { created: created.map((c) => postView(c.post, { media: c.media, timezone: c.tz })) };
}

// ---------- Read ----------

export async function getPost(ctx: Ctx, postId: string) {
  const { post, brand } = await loadPost(ctx, postId, "post.read");
  const [media, events, cals, insights] = await Promise.all([
    listMedia(ctx.db, post.id),
    ctx.db.select().from(postEvents).where(eq(postEvents.postId, post.id)).orderBy(asc(postEvents.createdAt)),
    ctx.db.select({ id: calendarPosts.calendarId }).from(calendarPosts).where(eq(calendarPosts.postId, post.id)),
    post.status === "published" ? ctx.db.select().from(postInsights).where(eq(postInsights.postId, post.id)).orderBy(desc(postInsights.capturedAt)).limit(1) : Promise.resolve([]),
  ]);
  const ins = insights[0];
  return {
    ...postView(post, { media, timezone: brand.timezone }),
    brand: { id: brand.id, slug: brand.slug, name: brand.name, timezone: brand.timezone },
    calendarIds: cals.map((c) => c.id),
    events: events.map((e) => ({
      at: e.createdAt.toISOString(),
      kind: e.kind,
      from: e.fromStatus,
      to: e.toStatus,
      actor: e.actorName,
      actorType: e.actorType,
      actingUser: e.actingUser,
      comment: e.comment,
      meta: e.meta,
    })),
    insights: ins ? { capturedAt: ins.capturedAt.toISOString(), reach: ins.reach, likes: ins.likes, comments: ins.comments, saves: ins.saves, shares: ins.shares, views: ins.views } : null,
    publishReadiness: validateForPublishing(post, media),
  };
}

const sortAt = sql<Date>`coalesce(${posts.publishedAt}, ${posts.scheduledAt}, ${posts.createdAt})`;

function encodeCursor(at: Date, postId: string) {
  return Buffer.from(`${at.toISOString()}|${postId}`).toString("base64url");
}
function decodeCursor(c: string): { at: Date; id: string } {
  const [at, pid] = Buffer.from(c, "base64url").toString().split("|");
  const d = new Date(at);
  if (!pid || Number.isNaN(d.getTime())) throw new AppError("validation_error", "Invalid cursor; pass the nextCursor value from the previous call.");
  return { at: d, id: pid };
}

export async function listPosts(ctx: Ctx, input: z.input<typeof listPostsSchema>) {
  const data = parse(listPostsSchema, input);
  const scope = brandScope(ctx.actor);
  const where: (SQL | undefined)[] = [];

  if (data.brandId) {
    const b = await getAccessibleBrand(ctx, data.brandId);
    assertCan(ctx.actor, "post.read", b);
    where.push(eq(posts.brandId, b.id));
  } else if (scope !== "all") {
    if (!scope.length) return { posts: [], nextCursor: null };
    where.push(inArray(posts.brandId, scope));
  }
  if (data.calendarId) {
    const [cal] = await ctx.db.select().from(calendars).where(eq(calendars.id, data.calendarId));
    if (!cal || (scope !== "all" && !scope.includes(cal.brandId))) throw notFound("Calendar", data.calendarId);
    where.push(eq(posts.brandId, cal.brandId));
    if (cal.kind === "custom") {
      where.push(inArray(posts.id, ctx.db.select({ id: calendarPosts.postId }).from(calendarPosts).where(eq(calendarPosts.calendarId, cal.id))));
    }
  }
  if (data.status?.length) where.push(inArray(posts.status, data.status));
  if (data.type?.length) where.push(inArray(posts.type, data.type));
  if (data.source?.length) where.push(inArray(posts.source, data.source));
  if (data.pillar) where.push(eq(posts.pillar, data.pillar));
  if (data.from) where.push(gte(sortAt, new Date(data.from)));
  if (data.to) where.push(lt(sortAt, new Date(data.to)));
  if (data.cursor) {
    const c = decodeCursor(data.cursor);
    where.push(sql`(${sortAt}, ${posts.id}) > (${c.at.toISOString()}::timestamptz, ${c.id}::uuid)`);
  }

  const rows = await ctx.db
    .select({ post: posts, timezone: brands.timezone, at: sql<string>`${sortAt}` })
    .from(posts)
    .innerJoin(brands, eq(brands.id, posts.brandId))
    .where(and(...where))
    .orderBy(asc(sortAt), asc(posts.id))
    .limit(data.limit + 1);

  const page = rows.slice(0, data.limit);
  const thumbs = page.length
    ? await ctx.db
        .select({ postId: postMedia.postId, url: postMedia.url })
        .from(postMedia)
        .where(and(inArray(postMedia.postId, page.map((r) => r.post.id)), eq(postMedia.position, 0)))
    : [];
  const thumbBy = new Map(thumbs.map((t) => [t.postId, t.url]));
  const last = page[page.length - 1];
  return {
    posts: page.map((r) => ({ ...postView(r.post, { timezone: r.timezone }), thumbnailUrl: r.post.thumbnailUrl ?? thumbBy.get(r.post.id) ?? null })),
    nextCursor: rows.length > data.limit && last ? encodeCursor(new Date(last.at), last.post.id) : null,
  };
}

// ---------- Edit ----------

export async function updatePost(ctx: Ctx, input: z.input<typeof updatePostSchema>) {
  const data = parse(updatePostSchema, input);
  const { brand } = await loadPost(ctx, data.postId, "post.edit");

  const result = await ctx.db.transaction(async (tx) => {
    const before = await lockPost(tx, data.postId);
    assertVersion(before, data.version);
    if (NOT_EDITABLE.includes(before.status)) throw new AppError("invalid_transition", `A '${before.status}' post can't be edited.`);
    if (data.scheduledAt !== undefined && before.status === "scheduled") {
      throw new AppError("validation_error", "This post is scheduled; change its time with reschedule_post.", { details: [{ field: "scheduledAt", message: "use reschedule_post" }] });
    }

    const patch: Partial<NewPostRow> = {};
    const changed: string[] = [];
    const candidates: [keyof Post, unknown][] = [
      ["type", data.type],
      ["caption", data.caption],
      ["hashtags", data.hashtags],
      ["firstComment", data.firstComment],
      ["pillar", data.pillar],
      ["notes", data.notes],
      ["isAiGenerated", data.isAiGenerated],
    ];
    for (const [key, value] of candidates) {
      if (value === undefined) continue;
      if (JSON.stringify(before[key] ?? null) === JSON.stringify(value ?? null)) continue;
      (patch as Record<string, unknown>)[key] = value;
      changed.push(key);
    }
    if (data.scheduledAt !== undefined) {
      const next = data.scheduledAt ? new Date(data.scheduledAt) : null;
      if (next?.getTime() !== before.scheduledAt?.getTime()) {
        patch.scheduledAt = next;
        changed.push("scheduledAt");
      }
    }
    if (!changed.length) return { before, after: before };

    const contentChanged = changed.some((c) => CONTENT_FIELDS.includes(c));
    if (contentChanged) Object.assign(patch, { igContainerId: null, publishPolls: 0 });
    const [bumped] = await tx
      .update(posts)
      .set({ ...patch, version: sql`${posts.version} + 1`, updatedAt: ctx.now() })
      .where(eq(posts.id, before.id))
      .returning();
    await recordEvent(tx, ctx, { postId: before.id, kind: "edit", meta: { fields: changed } });
    const after = contentChanged ? await reapproveIfContentChanged(tx, ctx, bumped, brand) : bumped;
    return { before, after };
  });
  await syncPublishJob(ctx, result.before, result.after);
  return postView(result.after, { timezone: brand.timezone });
}

export async function addComment(ctx: Ctx, input: { postId: string; comment: string; actingUser?: { id: string; name?: string } }) {
  const data = parse(reviewSchema.extend({ comment: z.string().min(1).max(4000) }), input);
  const { post } = await loadPost(ctx, data.postId, "post.comment");
  const c = await withActingUser(ctx, data.actingUser);
  await ctx.db.transaction((tx) => recordEvent(tx, c, { postId: post.id, kind: "comment", comment: data.comment }));
  return { ok: true };
}

// ---------- Approval ----------

export async function submitForApproval(ctx: Ctx, input: { postId: string; comment?: string; version?: number }) {
  const data = parse(z.object({ postId: id, comment: z.string().max(4000).optional(), version: z.number().int().positive().optional() }), input);
  const { brand } = await loadPost(ctx, data.postId, "post.submit");
  const media = await listMedia(ctx.db, data.postId);
  if (!media.length) throw new AppError("media_invalid", "Add at least one image or video before submitting for approval.", { hint: "Call add_media first." });
  const after = await ctx.db.transaction(async (tx) => {
    let p = await lockPost(tx, data.postId);
    assertVersion(p, data.version);
    if (p.status === "idea" || p.status === "rejected") p = await applyTransition(tx, ctx, { post: p, brand, to: "draft" });
    return applyTransition(tx, ctx, { post: p, brand, to: "awaiting_approval", comment: data.comment });
  });
  return { ...postView(after, { timezone: brand.timezone }), warnings: validateForPublishing(after, media) };
}

export async function approvePost(ctx: Ctx, input: z.input<typeof reviewSchema>) {
  const data = parse(reviewSchema, input);
  const { brand } = await loadPost(ctx, data.postId, "post.approve");
  const c = await withActingUser(ctx, data.actingUser);
  const after = await ctx.db.transaction(async (tx) => {
    const p = await lockPost(tx, data.postId);
    if (p.status !== "awaiting_approval") {
      throw new AppError("invalid_transition", `Only posts awaiting approval can be approved (this one is '${p.status}').`, {
        hint: p.status === "draft" ? "Call submit_for_approval first." : undefined,
      });
    }
    return applyTransition(tx, c, { post: p, brand, to: "approved", comment: data.comment });
  });
  return postView(after, { timezone: brand.timezone });
}

export async function rejectPost(ctx: Ctx, input: z.input<typeof reviewSchema>) {
  const data = parse(reviewSchema.extend({ comment: z.string().min(1, "say what should change").max(4000) }), input);
  const { brand } = await loadPost(ctx, data.postId, "post.approve");
  const c = await withActingUser(ctx, data.actingUser);
  const after = await ctx.db.transaction(async (tx) => {
    const p = await lockPost(tx, data.postId);
    return applyTransition(tx, c, { post: p, brand, to: "rejected", comment: data.comment });
  });
  return postView(after, { timezone: brand.timezone });
}

// ---------- Scheduling ----------

/** Lock the brand row so two concurrent next-free-slot requests can't pick the same slot. */
async function lockBrand(tx: Tx, brandId: string): Promise<Brand> {
  const [b] = await tx.select().from(brands).where(eq(brands.id, brandId)).for("update");
  return b;
}

type PostViewResult = ReturnType<typeof postView>;

export async function schedulePost(ctx: Ctx, input: z.input<typeof schedulePostSchema>): Promise<PostViewResult> {
  const data = parse(schedulePostSchema, input);
  const { post: current, brand } = await loadPost(ctx, data.postId, "post.schedule");
  if (current.status === "scheduled") return reschedulePost(ctx, input);
  if (current.status === "awaiting_approval") throw new AppError("invalid_transition", "This post is waiting for approval; it can be scheduled once approved.", { hint: "approve_post, then schedule_post." });
  assertPublishable(current, await listMedia(ctx.db, current.id));

  const result = await ctx.db.transaction(async (tx) => {
    const lockedBrand = await lockBrand(tx, brand.id);
    let p = await lockPost(tx, data.postId);
    const before = p;
    assertVersion(p, data.version);
    const at = data.nextFreeSlot ? await nextFreeSlot(ctx, lockedBrand, p.id, tx) : resolveTime(ctx, data.scheduledAt!);
    if (p.status === "draft" && !brand.requiresApproval) p = await applyTransition(tx, ctx, { post: p, brand, to: "approved", comment: "Auto-approved (brand doesn't require approval)" });
    const after = await applyTransition(tx, ctx, {
      post: p,
      brand,
      to: "scheduled",
      set: { scheduledAt: at, publishAttempts: 0, publishPolls: 0, lastError: null, nextAttemptAt: null },
      meta: { scheduledAt: at.toISOString(), nextFreeSlot: Boolean(data.nextFreeSlot) },
    });
    return { before, after };
  });
  await syncPublishJob(ctx, result.before, result.after);
  return postView(result.after, { timezone: brand.timezone });
}

export async function reschedulePost(ctx: Ctx, input: z.input<typeof schedulePostSchema>): Promise<PostViewResult> {
  const data = parse(schedulePostSchema, input);
  const { post: current, brand } = await loadPost(ctx, data.postId, "post.schedule");
  if (current.status === "approved") return schedulePost(ctx, input);
  const result = await ctx.db.transaction(async (tx) => {
    const lockedBrand = await lockBrand(tx, brand.id);
    const before = await lockPost(tx, data.postId);
    assertVersion(before, data.version);
    if (before.status !== "scheduled") throw new AppError("invalid_transition", `Only scheduled posts can be rescheduled (this one is '${before.status}').`);
    const at = data.nextFreeSlot ? await nextFreeSlot(ctx, lockedBrand, before.id, tx) : resolveTime(ctx, data.scheduledAt!);
    const [after] = await tx
      .update(posts)
      .set({ scheduledAt: at, version: sql`${posts.version} + 1`, updatedAt: ctx.now() })
      .where(eq(posts.id, before.id))
      .returning();
    await recordEvent(tx, ctx, { postId: before.id, kind: "edit", meta: { fields: ["scheduledAt"], from: before.scheduledAt?.toISOString(), to: at.toISOString() } });
    return { before, after };
  });
  await syncPublishJob(ctx, result.before, result.after);
  return postView(result.after, { timezone: brand.timezone });
}

export async function cancelPost(ctx: Ctx, input: { postId: string; comment?: string; version?: number }) {
  const data = parse(z.object({ postId: id, comment: z.string().max(4000).optional(), version: z.number().int().positive().optional() }), input);
  const { brand } = await loadPost(ctx, data.postId, "post.schedule");
  const result = await ctx.db.transaction(async (tx) => {
    const before = await lockPost(tx, data.postId);
    assertVersion(before, data.version);
    if (before.status === "publishing") throw new AppError("invalid_transition", "This post is being published right now and can't be cancelled.", { hint: "If it goes live, delete it in Instagram." });
    const after = await applyTransition(tx, ctx, { post: before, brand, to: "cancelled", comment: data.comment });
    return { before, after };
  });
  await syncPublishJob(ctx, result.before, result.after);
  return postView(result.after, { timezone: brand.timezone });
}

export async function retryFailedPost(ctx: Ctx, input: { postId: string; scheduledAt?: string }) {
  const data = parse(z.object({ postId: id, scheduledAt: z.iso.datetime({ offset: true }).optional() }), input);
  const { brand } = await loadPost(ctx, data.postId, "post.publish");
  const at = data.scheduledAt ? resolveTime(ctx, data.scheduledAt) : ctx.now();
  const result = await ctx.db.transaction(async (tx) => {
    const before = await lockPost(tx, data.postId);
    if (before.status !== "failed") throw new AppError("invalid_transition", `Only failed posts can be retried (this one is '${before.status}').`);
    // keep ig_container_id: the publisher checks it first so a retry can never double-post
    const after = await applyTransition(tx, ctx, {
      post: before,
      brand,
      to: "scheduled",
      comment: "Retry requested",
      set: { scheduledAt: at, publishAttempts: 0, publishPolls: 0, lastError: null, nextAttemptAt: null },
    });
    return { before, after };
  });
  await syncPublishJob(ctx, result.before, result.after);
  return postView(result.after, { timezone: brand.timezone });
}

/** Publish immediately through the same worker path as scheduled publishing. */
export async function publishNow(ctx: Ctx, input: { postId: string; version?: number }) {
  const data = parse(z.object({ postId: id, version: z.number().int().positive().optional() }), input);
  const { post: current, brand } = await loadPost(ctx, data.postId, "post.publish");
  assertPublishable(current, await listMedia(ctx.db, current.id));
  const now = ctx.now();
  const result = await ctx.db.transaction(async (tx) => {
    let p = await lockPost(tx, data.postId);
    const before = p;
    assertVersion(p, data.version);
    if (p.status === "draft" && !brand.requiresApproval) p = await applyTransition(tx, ctx, { post: p, brand, to: "approved", comment: "Auto-approved (brand doesn't require approval)" });
    if (p.status === "approved" || p.status === "failed") {
      p = await applyTransition(tx, ctx, { post: p, brand, to: "scheduled", comment: "Publish now", set: { scheduledAt: now, publishAttempts: 0, publishPolls: 0, lastError: null, nextAttemptAt: null } });
    } else if (p.status === "scheduled") {
      [p] = await tx.update(posts).set({ scheduledAt: now, version: sql`${posts.version} + 1`, updatedAt: now }).where(eq(posts.id, p.id)).returning();
      await recordEvent(tx, ctx, { postId: p.id, kind: "edit", comment: "Publish now", meta: { fields: ["scheduledAt"], from: before.scheduledAt?.toISOString(), to: now.toISOString() } });
    } else {
      throw new AppError("invalid_transition", `A '${p.status}' post can't be published now.`, {
        hint: p.status === "awaiting_approval" ? "Approve it first." : p.status === "draft" ? "Submit it for approval and approve it first." : undefined,
      });
    }
    return { before, after: p };
  });
  // the timed trigger is no longer needed; the publisher runs right here
  if (result.before.queueMessageId) await ctx.queue.cancel(result.before.queueMessageId).catch(() => undefined);
  const outcome = await publishPost(ctx, data.postId);
  const [fresh] = await ctx.db.select().from(posts).where(eq(posts.id, data.postId));
  return { outcome, post: postView(fresh, { timezone: brand.timezone }) };
}
