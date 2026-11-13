import { z } from "zod";

export const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:MM, e.g. 17:00");

export const postingSlotSchema = z.object({
  /** 0 = Sunday … 6 = Saturday, in the brand's timezone */
  weekday: z.number().int().min(0).max(6),
  time: timeOfDay,
});
export type PostingSlot = z.infer<typeof postingSlotSchema>;

export const brandGuidelinesSchema = z
  .object({
    focus: z.string().max(2000).optional(),
    voice: z.string().max(4000).optional(),
    pillars: z.array(z.string().min(1).max(80)).max(20).optional(),
    palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour like #8b7bff")).max(20).optional(),
    fonts: z.array(z.string().max(80)).max(10).optional(),
    visualStyle: z.string().max(2000).optional(),
    dos: z.array(z.string().max(300)).max(50).optional(),
    donts: z.array(z.string().max(300)).max(50).optional(),
    hashtagSets: z.record(z.string().min(1).max(40), z.array(z.string().regex(/^#?[\p{L}\p{N}_]+$/u)).max(30)).optional(),
    defaultCta: z.string().max(300).optional(),
  })
  .strict();
export type BrandGuidelines = z.infer<typeof brandGuidelinesSchema>;

export const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Unknown IANA timezone, e.g. Asia/Karachi" },
);

export const slugSchema = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase letters, digits and dashes, e.g. uppal-nq1");

const brandFields = {
  name: z.string().min(1).max(120),
  timezone: timezoneSchema,
  instagramHandle: z
    .string()
    .regex(/^@?[A-Za-z0-9._]{1,30}$/, "Instagram username like @uppal.nq1")
    .transform((h) => h.replace(/^@/, "")),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  guidelines: brandGuidelinesSchema,
  postingSlots: z.array(postingSlotSchema).max(50),
  requiresApproval: z.boolean(),
  clientsCanSchedule: z.boolean(),
};

export const createBrandSchema = z.object({
  ...brandFields,
  slug: slugSchema,
  timezone: brandFields.timezone.default("Asia/Karachi"),
  instagramHandle: brandFields.instagramHandle.optional(),
  color: brandFields.color.optional(),
  guidelines: brandFields.guidelines.default({}),
  postingSlots: brandFields.postingSlots.default([]),
  requiresApproval: brandFields.requiresApproval.default(true),
  clientsCanSchedule: brandFields.clientsCanSchedule.default(false),
});
export type CreateBrandInput = z.input<typeof createBrandSchema>;

/** Partial update: only the fields sent are changed. Built without defaults (Zod 4 applies defaults inside .partial()). */
export const updateBrandSchema = z.object(brandFields).partial();
