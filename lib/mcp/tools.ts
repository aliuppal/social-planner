import { z } from "zod";
import { AppError, parse } from "@/lib/errors";
import { brandGuidelinesSchema, postingSlotSchema } from "@/lib/schemas/brand";
import { POST_SOURCES, POST_STATUSES, POST_TYPES, actingUserSchema, createPostSchema, id, isoDate, isoDateTime, updatePostSchema } from "@/lib/schemas/post";
import type { Ctx } from "@/lib/services/context";
import * as brands from "@/lib/services/brands";
import * as calendars from "@/lib/services/calendars";
import * as insights from "@/lib/services/insights";
import * as media from "@/lib/services/media";
import * as posts from "@/lib/services/posts";
import { getFreeSlots } from "@/lib/services/scheduling";

/**
 * The single tool registry behind /api/mcp (MCP) and /api/v1/tools/{name} (REST).
 * Each tool: Zod input (also published as JSON Schema), the scope it needs, and a service call.
 * Services re-validate and enforce permissions; nothing here bypasses them.
 */

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  scope: string;
  readOnly: boolean;
  input: z.ZodObject;
  handler: (ctx: Ctx, input: never) => Promise<unknown>;
};

function tool<S extends z.ZodObject>(def: Omit<ToolDef, "input" | "handler"> & { input: S; handler: (ctx: Ctx, input: z.output<S>) => Promise<unknown> }): ToolDef {
  return def as unknown as ToolDef;
}

// ---------- shared fields ----------
const brandRef = z.string().min(1).describe("Brand id (UUID) or slug, e.g. uppal-nq1");
const postId = id.describe("Post id (UUID)");
const version = z.number().int().positive().describe("The post's current `version` from get_post; the call fails with version_conflict if someone changed it since");
const acting = actingUserSchema.describe("For inqi: the client-portal user you act for ({id, name}). Recorded in the audit log.");
const when = isoDateTime.describe("ISO-8601 with offset, e.g. 2026-11-12T17:00:00+05:00");

/** Resolve a brand id-or-slug the caller can access to its id (not_found otherwise). */
async function brandId(ctx: Ctx, ref: string) {
  return (await brands.getAccessibleBrand(ctx, ref)).id;
}

const createPostInput = createPostSchema.omit({ brandId: true }).extend({ brand: brandRef });

export const TOOLS: ToolDef[] = [
  // ---------- Brands ----------
  tool({
    name: "list_brands",
    title: "List brands",
    description: "Brands this key can access, with timezone, posting slots, approval rule and Instagram connection state.",
    scope: "brands:read",
    readOnly: true,
    input: z.object({ includeArchived: z.boolean().optional() }),
    handler: (ctx, i) => brands.listBrands(ctx, i),
  }),
  tool({
    name: "get_brand",
    title: "Get brand",
    description: "One brand with its full guidelines (voice, pillars, palette, do/don't rules, hashtag sets, default CTA) and posting slots. Never includes tokens.",
    scope: "brands:read",
    readOnly: true,
    input: z.object({ brand: brandRef }),
    handler: (ctx, i) => brands.getBrand(ctx, i.brand),
  }),
  tool({
    name: "update_brand_guidelines",
    title: "Update brand guidelines",
    description: "Change a brand's guidelines (merge by default; mode=replace overwrites) and optionally its weekly posting slots (wall-clock times in the brand timezone).",
    scope: "brands:write",
    readOnly: false,
    input: z.object({ brand: brandRef, guidelines: brandGuidelinesSchema, mode: z.enum(["merge", "replace"]).optional(), postingSlots: z.array(postingSlotSchema).max(50).optional() }),
    handler: async (ctx, { brand, ...rest }) => brands.updateBrandGuidelines(ctx, { ...rest, brandId: await brandId(ctx, brand) }),
  }),
  tool({
    name: "get_brand_status",
    title: "Get brand status",
    description: "Health check: Instagram connected?, token expiry, publishing quota left, counts of scheduled / awaiting approval / failed / missed posts, and the failed posts with their errors.",
    scope: "brands:read",
    readOnly: true,
    input: z.object({ brand: brandRef }),
    handler: (ctx, i) => brands.getBrandStatus(ctx, i.brand),
  }),

  // ---------- Posts ----------
  tool({
    name: "list_posts",
    title: "List posts",
    description: "Posts ordered by time (published time, else scheduled time, else created). Filter by brand, calendar, status, type, source, pillar and date range. Paginate with nextCursor.",
    scope: "posts:read",
    readOnly: true,
    input: z.object({
      brand: brandRef.optional(),
      calendarId: id.optional(),
      status: z.array(z.enum(POST_STATUSES)).optional(),
      type: z.array(z.enum(POST_TYPES)).optional(),
      source: z.array(z.enum(POST_SOURCES)).optional(),
      pillar: z.string().optional(),
      from: when.optional(),
      to: when.optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional().describe("nextCursor from the previous page"),
    }),
    handler: async (ctx, { brand, ...rest }) => posts.listPosts(ctx, { ...rest, brandId: brand ? await brandId(ctx, brand) : undefined }),
  }),
  tool({
    name: "get_post",
    title: "Get post",
    description:
      "Full post: caption, hashtags, media, schedule (UTC and brand-local), status, version, audit trail (who did what, when), latest insights if published, and publishReadiness (problems Instagram would reject).",
    scope: "posts:read",
    readOnly: true,
    input: z.object({ postId }),
    handler: (ctx, i) => posts.getPost(ctx, i.postId),
  }),
  tool({
    name: "create_post",
    title: "Create post",
    description:
      "Create a post as `idea` or `draft` (default). Media URLs are copied into storage (images converted to JPEG for Instagram). Returns the post plus `warnings` listing anything that would block publishing. scheduledAt here is only a planned time; use schedule_post to actually schedule.",
    scope: "posts:write",
    readOnly: false,
    input: createPostInput,
    handler: async (ctx, { brand, ...rest }) => posts.createPost(ctx, { ...rest, brandId: await brandId(ctx, brand) }),
  }),
  tool({
    name: "update_post",
    title: "Update post",
    description:
      "Edit caption, hashtags, first comment, type, pillar, notes or planned time. Requires `version`. Editing content of an approved/scheduled post sends it back to awaiting_approval (when the brand requires approval).",
    scope: "posts:write",
    readOnly: false,
    input: updatePostSchema,
    handler: (ctx, i) => posts.updatePost(ctx, i),
  }),
  tool({
    name: "add_media",
    title: "Add media",
    description: "Attach an image or video from a public URL (copied into storage; images converted to JPEG). position inserts at that index (0 = first); default appends.",
    scope: "posts:write",
    readOnly: false,
    input: media.addMediaSchema.extend({ postId, version: version.optional() }),
    handler: (ctx, i) => media.addMedia(ctx, i),
  }),
  tool({
    name: "remove_media",
    title: "Remove media",
    description: "Remove one media item from a post.",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ postId, mediaId: id, version: version.optional() }),
    handler: (ctx, i) => media.removeMedia(ctx, i),
  }),
  tool({
    name: "reorder_media",
    title: "Reorder media",
    description: "Set the media order. mediaIds must list every media id of the post exactly once, in the new order.",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ postId, mediaIds: z.array(id).min(1), version: version.optional() }),
    handler: (ctx, i) => media.reorderMedia(ctx, i),
  }),
  tool({
    name: "add_comment",
    title: "Comment on post",
    description: "Add a comment to the post's audit trail (feedback without changing status).",
    scope: "posts:write or posts:approve",
    readOnly: false,
    input: z.object({ postId, comment: z.string().min(1).max(4000), actingUser: acting.optional() }),
    handler: (ctx, i) => posts.addComment(ctx, i),
  }),
  tool({
    name: "submit_for_approval",
    title: "Submit for approval",
    description: "Move a draft (or idea/rejected post) to awaiting_approval. Needs at least one media item. Returns `warnings` for anything that would block publishing.",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ postId, comment: z.string().max(4000).optional(), version: version.optional() }),
    handler: (ctx, i) => posts.submitForApproval(ctx, i),
  }),
  tool({
    name: "approve_post",
    title: "Approve post",
    description: "Approve a post that is awaiting approval. inqi: pass actingUser so the audit log names the client.",
    scope: "posts:approve",
    readOnly: false,
    input: z.object({ postId, comment: z.string().max(4000).optional(), actingUser: acting.optional() }),
    handler: (ctx, i) => posts.approvePost(ctx, i),
  }),
  tool({
    name: "reject_post",
    title: "Reject post",
    description: "Reject a post awaiting approval. A comment saying what should change is required.",
    scope: "posts:approve",
    readOnly: false,
    input: z.object({ postId, comment: z.string().min(1).max(4000), actingUser: acting.optional() }),
    handler: (ctx, i) => posts.rejectPost(ctx, i),
  }),
  tool({
    name: "schedule_post",
    title: "Schedule post",
    description:
      "Schedule an approved post (or a draft, when the brand doesn't require approval). Pass exactly one of scheduledAt or nextFreeSlot: true (the brand's next open posting slot). The post is checked against Instagram's limits first; it then publishes automatically at that minute.",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ postId, scheduledAt: when.optional(), nextFreeSlot: z.boolean().optional(), version: version.optional() }),
    handler: (ctx, i) => posts.schedulePost(ctx, i),
  }),
  tool({
    name: "reschedule_post",
    title: "Reschedule post",
    description: "Move a scheduled post to a new time (scheduledAt) or to the next free slot (nextFreeSlot: true). The pending publish trigger is replaced.",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ postId, scheduledAt: when.optional(), nextFreeSlot: z.boolean().optional(), version: version.optional() }),
    handler: (ctx, i) => posts.reschedulePost(ctx, i),
  }),
  tool({
    name: "cancel_post",
    title: "Cancel post",
    description: "Cancel any post that isn't published or being published. Cancels its publish trigger.",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ postId, comment: z.string().max(4000).optional(), version: version.optional() }),
    handler: (ctx, i) => posts.cancelPost(ctx, i),
  }),
  tool({
    name: "publish_now",
    title: "Publish now",
    description: "Publish an approved or scheduled post immediately (same worker as scheduled publishing). Returns the outcome: published, pending (video still processing), retry or failed.",
    scope: "posts:publish",
    readOnly: false,
    input: z.object({ postId, version: version.optional() }),
    handler: (ctx, i) => posts.publishNow(ctx, i),
  }),
  tool({
    name: "retry_failed_post",
    title: "Retry failed post",
    description: "Put a failed post back on the schedule: now (default) or at scheduledAt. It never double-posts: an already-created Instagram container is checked first.",
    scope: "posts:publish",
    readOnly: false,
    input: z.object({ postId, scheduledAt: when.optional() }),
    handler: (ctx, i) => posts.retryFailedPost(ctx, i),
  }),

  // ---------- Planning ----------
  tool({
    name: "list_calendars",
    title: "List calendars",
    description: "Brand calendars (every post of the brand) and custom calendars (campaigns, series) this key can access.",
    scope: "posts:read",
    readOnly: true,
    input: z.object({ brand: brandRef.optional(), includeArchived: z.boolean().optional() }),
    handler: async (ctx, { brand, ...rest }) => calendars.listCalendars(ctx, { ...rest, brandId: brand ? await brandId(ctx, brand) : undefined }),
  }),
  tool({
    name: "create_calendar",
    title: "Create calendar",
    description: "Create a custom calendar inside a brand, e.g. a campaign ('Ramadan 2027') with an optional date range.",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ brand: brandRef, name: z.string().min(1).max(120), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), startsOn: isoDate.optional(), endsOn: isoDate.optional() }),
    handler: async (ctx, { brand, ...rest }) => calendars.createCalendar(ctx, { ...rest, brandId: await brandId(ctx, brand) }),
  }),
  tool({
    name: "add_post_to_calendar",
    title: "Add post to calendar",
    description: "Tag a post onto a custom calendar of the same brand.",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ calendarId: id, postId }),
    handler: (ctx, i) => calendars.addPostToCalendar(ctx, i),
  }),
  tool({
    name: "remove_post_from_calendar",
    title: "Remove post from calendar",
    description: "Untag a post from a custom calendar.",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ calendarId: id, postId }),
    handler: (ctx, i) => calendars.removePostFromCalendar(ctx, i),
  }),
  tool({
    name: "get_calendar",
    title: "Get calendar",
    description: "Posts in a date range grouped by day (YYYY-MM-DD in the brand's timezone), including published and imported posts. Pass calendarId or brand. Max range 92 days.",
    scope: "posts:read",
    readOnly: true,
    input: z.object({ calendarId: id.optional(), brand: brandRef.optional(), from: when, to: when, includeCancelled: z.boolean().optional() }),
    handler: async (ctx, { brand, ...rest }) => calendars.getCalendar(ctx, { ...rest, brandId: brand ? await brandId(ctx, brand) : undefined }),
  }),
  tool({
    name: "get_free_slots",
    title: "Get free slots",
    description: "Open posting slots for a brand (its weekly slots minus times already taken), with UTC and brand-local times. Default range: next 14 days.",
    scope: "posts:read",
    readOnly: true,
    input: z.object({ brand: brandRef, from: when.optional(), to: when.optional(), limit: z.number().int().min(1).max(100).optional() }),
    handler: async (ctx, { brand, ...rest }) => getFreeSlots(ctx, { ...rest, brandId: await brandId(ctx, brand) }),
  }),
  tool({
    name: "bulk_create_posts",
    title: "Bulk create posts",
    description: "Create up to 50 posts at once (e.g. a weekly plan). All-or-nothing: if any post is invalid nothing is created and the error names posts[i].",
    scope: "posts:write",
    readOnly: false,
    input: z.object({ posts: z.array(createPostInput).min(1).max(50) }),
    handler: async (ctx, i) => {
      const ids = new Map<string, string>();
      const resolved = [];
      for (const p of i.posts) {
        const { brand, ...rest } = p;
        if (!ids.has(brand)) ids.set(brand, await brandId(ctx, brand));
        resolved.push({ ...rest, brandId: ids.get(brand)! });
      }
      return posts.bulkCreatePosts(ctx, { posts: resolved });
    },
  }),

  // ---------- Insights ----------
  tool({
    name: "get_post_insights",
    title: "Get post insights",
    description: "Metric snapshots for a published post (reach, likes, comments, saves, shares, views), newest first.",
    scope: "insights:read",
    readOnly: true,
    input: z.object({ postId }),
    handler: (ctx, i) => insights.getPostInsights(ctx, i),
  }),
  tool({
    name: "get_brand_insights",
    title: "Get brand insights",
    description: "Totals for posts published in a range (default last 30 days), follower history, and top posts by saves, shares and reach.",
    scope: "insights:read",
    readOnly: true,
    input: z.object({ brand: brandRef, from: when.optional(), to: when.optional(), top: z.number().int().min(1).max(20).optional() }),
    handler: async (ctx, { brand, ...rest }) => insights.getBrandInsights(ctx, { ...rest, brandId: await brandId(ctx, brand) }),
  }),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Validate input and run a tool. Throws AppError (validation, permission, state) for the transport to format. */
export async function runTool(ctx: Ctx, name: string, args: unknown) {
  const def = TOOL_BY_NAME.get(name);
  if (!def) throw new AppError("not_found", `Unknown tool '${name}'.`, { hint: "Call tools/list (MCP) or GET /api/v1/tools for the available tools." });
  const input = parse(def.input, args ?? {});
  return def.handler(ctx, input as never);
}

export function toolJsonSchema(def: ToolDef) {
  return z.toJSONSchema(def.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown> & { type: "object" };
}
