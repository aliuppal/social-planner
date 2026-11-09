import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { postEvents, posts, type Brand, type Post, type PostStatus } from "@/lib/db/schema";
import { actorName } from "@/lib/auth/guard";
import { AppError } from "@/lib/errors";
import type { Ctx } from "./context";
import { emitEvent } from "./webhooks";

/**
 * The status state machine. This is the only place allowed transitions are defined.
 *
 *   idea → draft → awaiting_approval → approved → scheduled → publishing → published
 *                        ↓                                        ↓
 *                     rejected → draft                          failed → scheduled (retry)
 *   any non-published state → cancelled   (except `publishing`: it may already be live on Instagram)
 *   draft → approved   only when the brand has requires_approval = false
 *   approved|scheduled → awaiting_approval   when caption/media is edited (brand requires approval)
 */
export const TRANSITIONS: Readonly<Record<PostStatus, readonly PostStatus[]>> = {
  idea: ["draft", "cancelled"],
  draft: ["awaiting_approval", "approved", "cancelled"],
  awaiting_approval: ["approved", "rejected", "cancelled"],
  approved: ["scheduled", "awaiting_approval", "cancelled"],
  rejected: ["draft", "cancelled"],
  scheduled: ["publishing", "awaiting_approval", "cancelled"],
  publishing: ["published", "failed"],
  published: [],
  failed: ["scheduled", "cancelled"],
  cancelled: [],
};

/** Only the publisher (system actor) may move posts into these states. */
export const SYSTEM_ONLY_TARGETS: readonly PostStatus[] = ["publishing", "published", "failed"];

export type TransitionCheck = { ok: true } | { ok: false; message: string; hint?: string };

export function checkTransition(
  from: PostStatus,
  to: PostStatus,
  opts: { requiresApproval: boolean; actorKind: "user" | "api_client" | "system" },
): TransitionCheck {
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      message: `Can't move a post from '${from}' to '${to}'.`,
      hint: allowed.length ? `From '${from}' the post can move to: ${allowed.join(", ")}.` : `'${from}' is a final state.`,
    };
  }
  if (from === "draft" && to === "approved" && opts.requiresApproval) {
    return { ok: false, message: "This brand requires approval: submit the draft for approval first.", hint: "Call submit_for_approval, then approve_post." };
  }
  if (SYSTEM_ONLY_TARGETS.includes(to) && opts.actorKind !== "system") {
    return { ok: false, message: `Only the publisher can set status '${to}'.`, hint: "Use schedule_post or publish_now." };
  }
  return { ok: true };
}

export function assertVersion(post: Pick<Post, "version" | "id">, expected: number | undefined) {
  if (expected !== undefined && expected !== post.version) {
    throw new AppError("version_conflict", `Post ${post.id} was changed by someone else (you sent version ${expected}, current is ${post.version}).`, {
      hint: "Fetch the post again with get_post and re-apply your change.",
      data: { currentVersion: post.version },
    });
  }
}

/** SELECT … FOR UPDATE: callers hold the row lock for the rest of the transaction. */
export async function lockPost(tx: Tx, postId: string): Promise<Post> {
  const [row] = await tx.select().from(posts).where(eq(posts.id, postId)).for("update");
  if (!row) throw new AppError("not_found", `Post ${postId} not found`);
  return row;
}

export async function recordEvent(
  tx: Tx,
  ctx: Ctx,
  e: { postId: string; kind: "transition" | "comment" | "edit" | "publish_attempt"; from?: PostStatus | null; to?: PostStatus | null; comment?: string | null; meta?: Record<string, unknown> },
) {
  const a = ctx.actor;
  await tx.insert(postEvents).values({
    postId: e.postId,
    kind: e.kind,
    fromStatus: e.from ?? null,
    toStatus: e.to ?? null,
    comment: e.comment ?? null,
    actorType: a.kind,
    actorUserId: a.kind === "user" ? a.userId : null,
    actorApiClientId: a.kind === "api_client" ? a.clientId : null,
    actorName: actorName(a),
    actingUser: a.kind === "api_client" ? (a.actingUser ?? null) : null,
    meta: e.meta ?? null,
    createdAt: ctx.now(),
  });
}

/**
 * Caption/media edits on an approved or scheduled post send it back for approval
 * (only when the brand requires approval; otherwise the post keeps its status).
 * The pending publish job is cancelled by syncPublishJob after commit.
 */
export async function reapproveIfContentChanged(tx: Tx, ctx: Ctx, post: Post, brand: Pick<Brand, "id" | "requiresApproval">): Promise<Post> {
  if (!brand.requiresApproval || (post.status !== "approved" && post.status !== "scheduled")) return post;
  return applyTransition(tx, ctx, { post, brand, to: "awaiting_approval", comment: "Content edited; needs approval again", meta: { reason: "content_edited" } });
}

export type TransitionArgs = {
  post: Post;
  brand: Pick<Brand, "id" | "requiresApproval">;
  to: PostStatus;
  comment?: string | null;
  /** extra columns to set in the same UPDATE (e.g. scheduledAt, igMediaId) */
  set?: Partial<typeof posts.$inferInsert>;
  meta?: Record<string, unknown>;
};

/**
 * Apply one transition inside an open transaction on a row the caller has locked.
 * Bumps `version`, writes the audit event and the webhook outbox rows.
 * Queue side effects (enqueue/cancel publish job) are done by callers after commit.
 */
export async function applyTransition(tx: Tx, ctx: Ctx, args: TransitionArgs): Promise<Post> {
  const { post, brand, to } = args;
  const check = checkTransition(post.status, to, { requiresApproval: brand.requiresApproval, actorKind: ctx.actor.kind });
  if (!check.ok) throw new AppError("invalid_transition", check.message, { hint: check.hint, data: { status: post.status } });

  const [updated] = await tx
    .update(posts)
    .set({ ...args.set, status: to, version: sql`${posts.version} + 1`, updatedAt: ctx.now() })
    .where(eq(posts.id, post.id))
    .returning();

  await recordEvent(tx, ctx, { postId: post.id, kind: "transition", from: post.status, to, comment: args.comment, meta: args.meta });

  const payload = {
    postId: post.id,
    brandId: post.brandId,
    from: post.status,
    to,
    version: updated.version,
    scheduledAt: updated.scheduledAt?.toISOString() ?? null,
    actor: actorName(ctx.actor),
    comment: args.comment ?? null,
  };
  await emitEvent(tx, ctx, { event: "post.status_changed", brandId: post.brandId, payload });
  if (to === "published") {
    await emitEvent(tx, ctx, {
      event: "post.published",
      brandId: post.brandId,
      payload: { ...payload, igMediaId: updated.igMediaId, permalink: updated.permalink, publishedAt: updated.publishedAt?.toISOString() ?? null },
    });
  }
  if (to === "failed") {
    await emitEvent(tx, ctx, { event: "post.failed", brandId: post.brandId, payload: { ...payload, error: updated.lastError, attempts: updated.publishAttempts } });
  }
  return updated;
}
