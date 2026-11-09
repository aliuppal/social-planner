import { z } from "zod";
import { IG_LIMITS } from "@/lib/instagram/limits";

export const POST_STATUSES = [
  "idea",
  "draft",
  "awaiting_approval",
  "approved",
  "rejected",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
] as const;
export const POST_TYPES = ["image", "carousel", "reel"] as const;
export const POST_SOURCES = ["ui", "hermes", "inqi", "api", "instagram"] as const;

export const id = z.uuid({ message: "must be a UUID" });
/** ISO-8601 with an explicit offset or Z, e.g. 2026-11-10T17:00:00+05:00 */
export const isoDateTime = z.iso.datetime({ offset: true, message: "ISO-8601 datetime with offset, e.g. 2026-11-10T17:00:00+05:00" });
export const isoDate = z.iso.date({ message: "date as YYYY-MM-DD" });

const hashtag = z
  .string()
  .regex(/^#?[\p{L}\p{N}_]+$/u, "hashtags may contain letters, digits and _ only")
  .transform((h) => (h.startsWith("#") ? h : `#${h}`));

export const actingUserSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
});

const postFields = {
  type: z.enum(POST_TYPES),
  caption: z.string().max(IG_LIMITS.caption.maxChars, `caption is limited to ${IG_LIMITS.caption.maxChars} characters`).default(""),
  hashtags: z.array(hashtag).max(IG_LIMITS.caption.maxHashtags).default([]),
  firstComment: z.string().max(IG_LIMITS.caption.maxChars).nullish(),
  pillar: z.string().max(80).nullish(),
  notes: z.string().max(10_000).nullish(),
  isAiGenerated: z.boolean().default(false),
};

export const createPostSchema = z.object({
  brandId: id,
  ...postFields,
  status: z.enum(["idea", "draft"]).default("draft"),
  /** Optional planned time; the post is only *scheduled* via schedulePost. */
  scheduledAt: isoDateTime.nullish(),
  calendarIds: z.array(id).max(20).default([]),
  media: z
    .array(z.object({ url: z.url(), altText: z.string().max(IG_LIMITS.altText.maxChars).optional() }))
    .max(IG_LIMITS.carousel.maxItems)
    .default([]),
});
export type CreatePostInput = z.input<typeof createPostSchema>;

export const updatePostSchema = z
  .object({
    postId: id,
    version: z.number().int().positive({ message: "pass the post's current version (from get_post)" }),
    type: postFields.type.optional(),
    caption: z.string().max(IG_LIMITS.caption.maxChars).optional(),
    hashtags: z.array(hashtag).max(IG_LIMITS.caption.maxHashtags).optional(),
    firstComment: postFields.firstComment,
    pillar: postFields.pillar,
    notes: postFields.notes,
    isAiGenerated: z.boolean().optional(),
    scheduledAt: isoDateTime.nullish(),
  })
  .strict();
export type UpdatePostInput = z.input<typeof updatePostSchema>;

export const schedulePostSchema = z
  .object({
    postId: id,
    scheduledAt: isoDateTime.optional(),
    nextFreeSlot: z.boolean().optional(),
    version: z.number().int().positive().optional(),
  })
  .refine((v) => Boolean(v.scheduledAt) !== Boolean(v.nextFreeSlot), {
    message: "pass exactly one of scheduledAt or nextFreeSlot: true",
    path: ["scheduledAt"],
  });
export type SchedulePostInput = z.input<typeof schedulePostSchema>;

export const listPostsSchema = z.object({
  brandId: id.optional(),
  calendarId: id.optional(),
  status: z.array(z.enum(POST_STATUSES)).optional(),
  type: z.array(z.enum(POST_TYPES)).optional(),
  source: z.array(z.enum(POST_SOURCES)).optional(),
  pillar: z.string().optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListPostsInput = z.input<typeof listPostsSchema>;

export const reviewSchema = z.object({
  postId: id,
  comment: z.string().max(4000).optional(),
  actingUser: actingUserSchema.optional(),
});

export const freeSlotsSchema = z.object({
  brandId: id,
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
