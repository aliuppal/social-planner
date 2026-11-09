import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import { brands, instagramAccounts, postMedia, posts, type Post } from "@/lib/db/schema";
import { systemActor } from "@/lib/auth/guard";
import { decryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { InstagramApiError, type IgAuth } from "@/lib/instagram/client";
import { IG_LIMITS } from "@/lib/instagram/limits";
import { sanitizeError } from "@/lib/logger";
import { MINUTE } from "@/lib/time";
import { withActor, type Ctx, type Deps } from "./context";
import { composeCaption, listMedia } from "./media";
import { applyTransition, lockPost, recordEvent } from "./post-status";

/** While a worker handles a post, other workers skip it until the lease runs out (crash recovery). */
export const LEASE_MS = 5 * MINUTE;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE];
const QUOTA_RETRY_MS = 30 * MINUTE;

export type PublishOutcome = {
  postId: string;
  result: "published" | "pending" | "retry" | "failed" | "skipped";
  detail?: string;
  retryAt?: string;
};

class QuotaExhausted extends Error {}

const publisherCtx = (deps: Deps): Ctx => withActor(deps, systemActor("publisher"));

// ---------- Entry points (job route, sweep, publish_now all use these) ----------

/** Publish one post if it is due (scheduled_at ≤ now) or due for a retry/poll. */
export async function publishPost(deps: Deps, postId: string): Promise<PublishOutcome> {
  const [claimed] = await claim(deps, { postId, limit: 1 });
  if (!claimed) return { postId, result: "skipped", detail: "not due, or another worker is handling it" };
  return processClaimed(deps, claimed);
}

/** Safety-net sweep: everything due that the exact-time trigger missed. */
export async function runDuePublishes(deps: Deps, opts: { limit?: number } = {}): Promise<PublishOutcome[]> {
  const claimed = await claim(deps, { limit: opts.limit ?? 10 });
  const out: PublishOutcome[] = [];
  for (const p of claimed) out.push(await processClaimed(deps, p));
  return out;
}

// ---------- Claim (row locks; SKIP LOCKED so parallel workers never take the same post) ----------

async function claim(deps: Deps, opts: { postId?: string; limit: number }): Promise<Post[]> {
  const ctx = publisherCtx(deps);
  return deps.db.transaction(async (tx) => {
    const now = deps.now();
    const due = or(and(eq(posts.status, "scheduled"), lte(posts.scheduledAt, now)), and(eq(posts.status, "publishing"), lte(posts.nextAttemptAt, now)));
    const rows = await tx
      .select()
      .from(posts)
      .where(and(due, opts.postId ? eq(posts.id, opts.postId) : undefined))
      .orderBy(asc(posts.scheduledAt))
      .limit(opts.limit)
      .for("update", { skipLocked: true });
    if (!rows.length) return [];
    const brandRows = await tx.select({ id: brands.id, requiresApproval: brands.requiresApproval }).from(brands).where(inArray(brands.id, [...new Set(rows.map((r) => r.brandId))]));
    const brandBy = new Map(brandRows.map((b) => [b.id, b]));
    const lease = new Date(now.getTime() + LEASE_MS);
    const out: Post[] = [];
    for (const p of rows) {
      if (p.status === "scheduled") {
        out.push(await applyTransition(tx, ctx, { post: p, brand: brandBy.get(p.brandId)!, to: "publishing", set: { nextAttemptAt: lease, queueMessageId: null } }));
      } else {
        const [u] = await tx.update(posts).set({ nextAttemptAt: lease }).where(eq(posts.id, p.id)).returning();
        out.push(u);
      }
    }
    return out;
  });
}

// ---------- Process (network calls happen outside any transaction) ----------

async function processClaimed(deps: Deps, post: Post): Promise<PublishOutcome> {
  try {
    const auth = await getIgAuth(deps, post.brandId);

    // Crash after media_publish but before we marked it published: just finish.
    if (post.igMediaId) return await finish(deps, post, auth, post.igMediaId);

    let containerId = post.igContainerId;
    if (containerId) {
      // Idempotency: never publish a container twice. Ask Instagram what happened to it first.
      const { status } = await deps.ig.getContainerStatus(auth, containerId);
      if (status === "PUBLISHED") return await finish(deps, post, auth, await recoverMediaId(deps, auth, post));
      if (status === "IN_PROGRESS") return await waitForProcessing(deps, post);
      if (status === "EXPIRED" || status === "ERROR") {
        await resetContainers(deps, post.id);
        containerId = null;
        if (status === "ERROR") throw new InstagramApiError("Instagram couldn't process the media (container status ERROR)", { transient: true });
      }
    }

    await checkQuota(deps, auth, post);

    if (!containerId) {
      const created = await createContainers(deps, auth, post);
      if (created === "children_pending") return await waitForProcessing(deps, post);
      containerId = created;
      const { status } = await deps.ig.getContainerStatus(auth, containerId);
      if (status === "IN_PROGRESS") return await waitForProcessing(deps, post);
      if (status !== "FINISHED") throw new InstagramApiError(`Container not ready (${status})`, { transient: true });
    }

    const { mediaId } = await deps.ig.publishContainer(auth, containerId);
    // Persist immediately: if anything below fails, the next run finishes instead of re-posting.
    await deps.db.update(posts).set({ igMediaId: mediaId }).where(eq(posts.id, post.id));
    return await finish(deps, post, auth, mediaId);
  } catch (err) {
    return handleFailure(deps, post, err);
  }
}

async function getIgAuth(deps: Deps, brandId: string): Promise<IgAuth> {
  const [acct] = await deps.db.select().from(instagramAccounts).where(eq(instagramAccounts.brandId, brandId));
  if (!acct || acct.status === "disconnected") {
    if (deps.igMode === "mock") return { igUserId: "mock-ig-user", accessToken: "mock" };
    throw new AppError("instagram_error", "No Instagram account is connected to this brand.", { hint: "Connect the account on the brand page." });
  }
  if (acct.status === "expired") throw new AppError("instagram_error", "The Instagram token has expired; reconnect the account on the brand page.");
  return { igUserId: acct.igUserId, accessToken: decryptSecret(acct.accessTokenEnc) };
}

async function checkQuota(deps: Deps, auth: IgAuth, post: Post) {
  try {
    const limit = await deps.ig.getPublishingLimit(auth);
    await deps.db.update(instagramAccounts).set({ quotaUsed: limit.used, quotaTotal: limit.total, quotaCheckedAt: deps.now() }).where(eq(instagramAccounts.brandId, post.brandId));
    if (limit.used >= limit.total) throw new QuotaExhausted(`Instagram publishing limit reached (${limit.used}/${limit.total} in 24h)`);
  } catch (err) {
    if (err instanceof QuotaExhausted) throw err;
    // the quota check is advisory; Instagram enforces the real limit on publish
    deps.log.warn({ postId: post.id, err: sanitizeError(err) }, "could not read publishing limit");
  }
}

/** Create the container(s), persisting every id the moment Instagram returns it. */
async function createContainers(deps: Deps, auth: IgAuth, post: Post): Promise<string | "children_pending"> {
  const media = await listMedia(deps.db, post.id);
  const caption = composeCaption(post);
  const aiFlag = post.isAiGenerated || undefined;

  if (post.type !== "carousel") {
    const m = media[0];
    if (!m) throw new AppError("media_invalid", "Post has no media");
    const { id } =
      post.type === "reel"
        ? await deps.ig.createContainer(auth, { kind: "reel", videoUrl: m.url, caption, isAiGenerated: aiFlag })
        : await deps.ig.createContainer(auth, { kind: "image", imageUrl: m.url, caption, altText: m.altText ?? undefined, isAiGenerated: aiFlag });
    await deps.db.update(posts).set({ igContainerId: id }).where(eq(posts.id, post.id));
    return id;
  }

  const childIds: string[] = [];
  let pending = false;
  for (const m of media) {
    let childId = m.igChildContainerId;
    const isVideo = m.mimeType.startsWith("video/");
    if (!childId) {
      ({ id: childId } = await deps.ig.createContainer(auth, isVideo ? { kind: "carousel_item", videoUrl: m.url } : { kind: "carousel_item", imageUrl: m.url, altText: m.altText ?? undefined }));
      await deps.db.update(postMedia).set({ igChildContainerId: childId }).where(eq(postMedia.id, m.id));
    }
    if (isVideo) {
      const { status } = await deps.ig.getContainerStatus(auth, childId);
      if (status === "IN_PROGRESS") pending = true;
      else if (status === "ERROR" || status === "EXPIRED") {
        await deps.db.update(postMedia).set({ igChildContainerId: null }).where(eq(postMedia.id, m.id));
        throw new InstagramApiError(`Carousel video ${m.position + 1} failed processing (${status})`, { transient: true });
      }
    }
    childIds.push(childId);
  }
  if (pending) return "children_pending";
  const { id } = await deps.ig.createContainer(auth, { kind: "carousel", children: childIds, caption, isAiGenerated: aiFlag });
  await deps.db.update(posts).set({ igContainerId: id }).where(eq(posts.id, post.id));
  return id;
}

async function resetContainers(deps: Deps, postId: string) {
  await deps.db.update(posts).set({ igContainerId: null, publishPolls: 0 }).where(eq(posts.id, postId));
  await deps.db.update(postMedia).set({ igChildContainerId: null }).where(eq(postMedia.postId, postId));
}

/** Container was published but we never stored the media id: find it among recent media by caption. */
async function recoverMediaId(deps: Deps, auth: IgAuth, post: Post): Promise<string | null> {
  const since = new Date((post.scheduledAt ?? post.updatedAt).getTime() - 60 * MINUTE);
  const recent = await deps.ig.listRecentMedia(auth, { limit: 25, since });
  if (!recent.length) return null;
  const expected = composeCaption(post).trim();
  const linked = await deps.db
    .select({ id: posts.igMediaId })
    .from(posts)
    .where(and(eq(posts.brandId, post.brandId), inArray(posts.igMediaId, recent.map((r) => r.id))));
  const taken = new Set(linked.map((r) => r.id));
  return recent.find((m) => !taken.has(m.id) && (m.caption ?? "").trim() === expected)?.id ?? null;
}

/** Video still processing: check again in a minute (docs: once per minute, at most 5 minutes). */
async function waitForProcessing(deps: Deps, post: Post): Promise<PublishOutcome> {
  const polls = post.publishPolls + 1;
  if (polls > IG_LIMITS.containerPoll.maxPolls) {
    throw new InstagramApiError(`Instagram is still processing the video after ${IG_LIMITS.containerPoll.maxPolls} minutes`, { transient: true });
  }
  const at = new Date(deps.now().getTime() + IG_LIMITS.containerPoll.intervalMs);
  await deps.db.update(posts).set({ publishPolls: polls, nextAttemptAt: at }).where(eq(posts.id, post.id));
  await deps.queue.enqueuePublish(post.id, at).catch((err) => deps.log.warn({ postId: post.id, err: sanitizeError(err) }, "poll enqueue failed; sweep will retry"));
  return { postId: post.id, result: "pending", detail: `media processing (check ${polls}/${IG_LIMITS.containerPoll.maxPolls})`, retryAt: at.toISOString() };
}

async function finish(deps: Deps, post: Post, auth: IgAuth, mediaId: string | null): Promise<PublishOutcome> {
  const ctx = publisherCtx(deps);
  let permalink: string | null = null;
  let publishedAt = deps.now();
  let thumbnailUrl: string | null = null;
  if (mediaId) {
    try {
      const m = await deps.ig.getMedia(auth, mediaId);
      permalink = m.permalink ?? null;
      publishedAt = m.timestamp ?? publishedAt;
      thumbnailUrl = m.thumbnailUrl ?? m.mediaUrl ?? null;
    } catch (err) {
      deps.log.warn({ postId: post.id, err: sanitizeError(err) }, "published, but could not read permalink yet");
    }
  }

  const done = await deps.db.transaction(async (tx) => {
    const locked = await lockPost(tx, post.id);
    if (locked.status !== "publishing") return null;
    const [brand] = await tx.select({ id: brands.id, requiresApproval: brands.requiresApproval }).from(brands).where(eq(brands.id, post.brandId));
    return applyTransition(tx, ctx, {
      post: locked,
      brand,
      to: "published",
      set: {
        igMediaId: mediaId,
        permalink,
        publishedAt,
        thumbnailUrl: thumbnailUrl ?? locked.thumbnailUrl,
        nextAttemptAt: null,
        publishPolls: 0,
        lastError: mediaId ? null : "Published, but the Instagram media id couldn't be confirmed yet; the Instagram sync will link it.",
      },
    });
  });
  if (!done) return { postId: post.id, result: "skipped", detail: "already finished by another worker" };

  if (post.firstComment && mediaId) {
    try {
      await deps.ig.postComment(auth, mediaId, post.firstComment);
      await deps.db.transaction((tx) => recordEvent(tx, ctx, { postId: post.id, kind: "publish_attempt", comment: "First comment posted" }));
    } catch (err) {
      await deps.db.transaction((tx) => recordEvent(tx, ctx, { postId: post.id, kind: "publish_attempt", comment: "First comment failed", meta: { error: sanitizeError(err) } }));
    }
  }
  return { postId: post.id, result: "published", detail: permalink ?? undefined };
}

async function handleFailure(deps: Deps, post: Post, err: unknown): Promise<PublishOutcome> {
  const ctx = publisherCtx(deps);
  const now = deps.now();
  const message = sanitizeError(err);
  deps.log.warn({ postId: post.id, attempt: post.publishAttempts + 1, err: message }, "publish attempt failed");

  if (err instanceof QuotaExhausted) {
    const retryAt = new Date(now.getTime() + QUOTA_RETRY_MS);
    await deps.db.transaction(async (tx) => {
      await tx.update(posts).set({ nextAttemptAt: retryAt, lastError: message }).where(eq(posts.id, post.id));
      await recordEvent(tx, ctx, { postId: post.id, kind: "publish_attempt", comment: message, meta: { retryAt: retryAt.toISOString(), quota: true } });
    });
    await deps.queue.enqueuePublish(post.id, retryAt).catch(() => undefined);
    return { postId: post.id, result: "retry", detail: message, retryAt: retryAt.toISOString() };
  }

  const transient = err instanceof InstagramApiError ? err.transient : !(err instanceof AppError);
  const attempts = post.publishAttempts + 1;
  const giveUp = !transient || attempts >= MAX_ATTEMPTS;
  const retryAt = giveUp ? null : new Date(now.getTime() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);

  const outcome = await deps.db.transaction(async (tx) => {
    const locked = await lockPost(tx, post.id);
    if (locked.status !== "publishing") return null;
    if (giveUp) {
      const [brand] = await tx.select({ id: brands.id, requiresApproval: brands.requiresApproval }).from(brands).where(eq(brands.id, post.brandId));
      await applyTransition(tx, ctx, {
        post: locked,
        brand,
        to: "failed",
        comment: message,
        set: { publishAttempts: attempts, lastError: message, nextAttemptAt: null, publishPolls: 0 },
        meta: { attempt: attempts, transient },
      });
      return "failed" as const;
    }
    await tx.update(posts).set({ publishAttempts: attempts, lastError: message, nextAttemptAt: retryAt, publishPolls: 0 }).where(eq(posts.id, post.id));
    await recordEvent(tx, ctx, { postId: post.id, kind: "publish_attempt", comment: message, meta: { attempt: attempts, retryAt: retryAt!.toISOString() } });
    return "retry" as const;
  });
  if (!outcome) return { postId: post.id, result: "skipped", detail: "post changed while publishing" };
  if (outcome === "retry") await deps.queue.enqueuePublish(post.id, retryAt!).catch(() => undefined);
  return { postId: post.id, result: outcome, detail: message, retryAt: retryAt?.toISOString() };
}
