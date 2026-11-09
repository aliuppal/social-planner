import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError, fromZod } from "@/lib/errors";
import { createPostSchema, schedulePostSchema, updatePostSchema } from "@/lib/schemas/post";
import { brandGuidelinesSchema, postingSlotSchema } from "@/lib/schemas/brand";
import { addMedia, composeCaption, reorderMedia, validateForPublishing } from "@/lib/services/media";
import { approvePost, bulkCreatePosts, createPost, schedulePost, submitForApproval } from "@/lib/services/posts";
import { IMG, IMG2, makeBrand, makeUser, setupEnv, type TestEnv } from "./helpers";

const UUID = "6f1c2f0e-8a8b-4b55-9a39-6c0f6f1e2a10";
const jpeg = { mimeType: "image/jpeg", width: 1080, height: 1350, sizeBytes: 500_000, durationMs: null, altText: null };

describe("shared Zod schemas (used by MCP, REST and UI)", () => {
  it("create_post: names every bad field", () => {
    const r = createPostSchema.safeParse({ brandId: "nope", type: "story", caption: "x".repeat(2201), hashtags: ["ok", "bad tag"] });
    expect(r.success).toBe(false);
    const err = fromZod(r.error!);
    expect(err.code).toBe("validation_error");
    expect(err.opts.details!.map((d) => d.field).sort()).toEqual(["brandId", "caption", "hashtags.1", "type"]);
    expect(err.message).toContain("caption is limited to 2200 characters");
  });

  it("create_post: normalises hashtags and applies defaults", () => {
    const r = createPostSchema.parse({ brandId: UUID, type: "image", hashtags: ["nq1", "#futures"] });
    expect(r).toMatchObject({ status: "draft", caption: "", hashtags: ["#nq1", "#futures"], calendarIds: [], media: [] });
  });

  it("create_post: only idea or draft can be the starting status", () => {
    expect(createPostSchema.safeParse({ brandId: UUID, type: "image", status: "scheduled" }).success).toBe(false);
  });

  it("schedule_post: needs exactly one of scheduledAt or nextFreeSlot, and an offset on the time", () => {
    expect(schedulePostSchema.safeParse({ postId: UUID }).success).toBe(false);
    expect(schedulePostSchema.safeParse({ postId: UUID, nextFreeSlot: true, scheduledAt: "2026-11-11T17:00:00+05:00" }).success).toBe(false);
    expect(schedulePostSchema.safeParse({ postId: UUID, scheduledAt: "2026-11-11T17:00:00" }).success).toBe(false);
    expect(schedulePostSchema.safeParse({ postId: UUID, scheduledAt: "2026-11-11T17:00:00+05:00" }).success).toBe(true);
    expect(schedulePostSchema.safeParse({ postId: UUID, nextFreeSlot: true }).success).toBe(true);
  });

  it("update_post: requires version and rejects unknown fields", () => {
    expect(updatePostSchema.safeParse({ postId: UUID, caption: "x" }).success).toBe(false);
    expect(updatePostSchema.safeParse({ postId: UUID, version: 1, status: "approved" }).success).toBe(false);
  });

  it("brand guidelines and slots", () => {
    expect(postingSlotSchema.safeParse({ weekday: 7, time: "17:00" }).success).toBe(false);
    expect(postingSlotSchema.safeParse({ weekday: 1, time: "5pm" }).success).toBe(false);
    expect(brandGuidelinesSchema.safeParse({ palette: ["red"] }).success).toBe(false);
    expect(brandGuidelinesSchema.safeParse({ unknownKey: 1 }).success).toBe(false);
  });
});

describe("Instagram limits (validateForPublishing)", () => {
  const post = (over: Partial<{ type: "image" | "carousel" | "reel"; caption: string; hashtags: string[] }> = {}) => ({ type: "image" as const, caption: "hi", hashtags: [] as string[], ...over });

  it("accepts a valid 4:5 JPEG", () => {
    expect(validateForPublishing(post(), [jpeg])).toEqual([]);
  });

  it("rejects PNG, wrong aspect ratio and oversize images with fix-it messages", () => {
    const issues = validateForPublishing(post(), [{ ...jpeg, mimeType: "image/png", width: 1080, height: 1920, sizeBytes: 9 * 1024 * 1024 }]);
    const text = issues.map((i) => i.message).join(" | ");
    expect(text).toContain("only accepts JPEG");
    expect(text).toContain("aspect ratio 1080x1920");
    expect(text).toContain("max is 8 MB");
  });

  it("checks media counts per type", () => {
    expect(validateForPublishing(post(), [])[0].message).toContain("exactly 1 image");
    expect(validateForPublishing(post({ type: "carousel" }), [jpeg])[0].message).toContain("2–20 items");
    expect(validateForPublishing(post({ type: "carousel" }), Array(21).fill(jpeg))[0].message).toContain("2–20 items");
  });

  it("checks caption length, hashtag count and mentions on the composed caption", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`);
    expect(validateForPublishing(post({ hashtags: tags }), [jpeg]).map((i) => i.field)).toContain("hashtags");
    expect(validateForPublishing(post({ caption: "@a ".repeat(21) }), [jpeg])[0].message).toContain("@mentions");
    expect(validateForPublishing(post({ caption: "x".repeat(2195), hashtags: ["#abcdef"] }), [jpeg])[0].message).toContain("limit is 2200");
  });

  it("composes caption + hashtags without duplicating tags already in the caption", () => {
    expect(composeCaption({ caption: "Patience #nq1", hashtags: ["#nq1", "#futures"] })).toBe("Patience #nq1\n\n#futures");
  });

  it("reels: format, duration and alt text", () => {
    const issues = validateForPublishing(post({ type: "reel" }), [{ mimeType: "video/webm", width: 1080, height: 1920, sizeBytes: 1000, durationMs: 1000, altText: "x" }]);
    expect(issues.map((i) => i.message).join(" | ")).toMatch(/MP4 or MOV.*3s–15min.*only supported on images/);
  });
});

describe("validation through the services", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setupEnv();
  });
  afterEach(async () => env.close());

  it("schedule_post refuses a post Instagram would reject and lists every problem", async () => {
    const brand = await makeBrand(env, { slug: "val", requiresApproval: false });
    const owner = await makeUser(env, "owner");
    const p = await createPost(env.ctx(owner), { brandId: brand.id, type: "carousel", media: [{ url: "https://cdn.example.test/a.png" }] });
    expect(p.warnings.length).toBeGreaterThan(0);
    const err = await schedulePost(env.ctx(owner), { postId: p.id, nextFreeSlot: true }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("media_invalid");
    expect(err.opts.details.map((d: { field: string }) => d.field)).toEqual(["media", "media[0]"]);
  });

  it("submit_for_approval needs media", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const p = await createPost(env.ctx(owner), { brandId: brand.id, type: "image" });
    await expect(submitForApproval(env.ctx(owner), { postId: p.id })).rejects.toMatchObject({ code: "media_invalid", opts: { hint: "Call add_media first." } });
  });

  it("add_media inserts at a position; reorder_media must list every id", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const p = await createPost(env.ctx(owner), { brandId: brand.id, type: "carousel", media: [{ url: IMG }] });
    const added = await addMedia(env.ctx(owner), { postId: p.id, url: IMG2, position: 0 });
    expect(added.media.position).toBe(0);
    await submitForApproval(env.ctx(owner), { postId: p.id });
    expect((await approvePost(env.ctx(owner), { postId: p.id })).status).toBe("approved");
    await expect(reorderMedia(env.ctx(owner), { postId: p.id, mediaIds: [added.media.id] })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("bulk_create_posts is all-or-nothing and points at the bad item", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const err = await bulkCreatePosts(env.ctx(owner), { posts: [{ brandId: brand.id, type: "image" }, { brandId: brand.id, type: "gif" }] }).catch((e) => e);
    expect(err.code).toBe("validation_error");
    expect(err.message).toMatch(/^posts\[1\]:/);
    const ok = await bulkCreatePosts(env.ctx(owner), { posts: [{ brandId: brand.id, type: "image" }, { brandId: brand.id, type: "reel" }] });
    expect(ok.created).toHaveLength(2);
  });
});
