import { and, eq, gte, lt, ne, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/lib/db";
import { posts, type Brand } from "@/lib/db/schema";
import { assertCan } from "@/lib/auth/guard";
import { AppError, parse } from "@/lib/errors";
import { freeSlotsSchema } from "@/lib/schemas/post";
import { DAY, MINUTE, expandSlots, toZonedIso } from "@/lib/time";
import type { Ctx } from "./context";
import { getAccessibleBrand } from "./brands";

/** A slot counts as taken if any live post sits within ±30 min of it. */
export const SLOT_WINDOW_MS = 30 * MINUTE;
/** Earliest a post can be scheduled from now (gives the trigger time to register). */
export const MIN_LEAD_MS = 1 * MINUTE;
const NEXT_SLOT_HORIZON_MS = 60 * DAY;

/** Times of live posts (scheduled/planned/published) for a brand in a range. */
async function occupiedTimes(db: DbOrTx, brandId: string, from: Date, to: Date, excludePostId?: string): Promise<number[]> {
  const lo = new Date(from.getTime() - SLOT_WINDOW_MS);
  const hi = new Date(to.getTime() + SLOT_WINDOW_MS);
  const rows = await db
    .select({ scheduledAt: posts.scheduledAt, publishedAt: posts.publishedAt })
    .from(posts)
    .where(
      and(
        eq(posts.brandId, brandId),
        notInArray(posts.status, ["cancelled", "rejected", "failed"]),
        or(and(gte(posts.scheduledAt, lo), lt(posts.scheduledAt, hi)), and(gte(posts.publishedAt, lo), lt(posts.publishedAt, hi))),
        excludePostId ? ne(posts.id, excludePostId) : undefined,
      ),
    );
  return rows.map((r) => (r.publishedAt ?? r.scheduledAt)!.getTime());
}

export async function computeFreeSlots(db: DbOrTx, brand: Brand, from: Date, to: Date, opts: { limit?: number; excludePostId?: string } = {}): Promise<Date[]> {
  const candidates = expandSlots(brand.postingSlots, brand.timezone, from, to);
  if (!candidates.length) return [];
  const taken = await occupiedTimes(db, brand.id, from, to, opts.excludePostId);
  const free = candidates.filter((c) => !taken.some((t) => Math.abs(t - c.getTime()) < SLOT_WINDOW_MS));
  return opts.limit ? free.slice(0, opts.limit) : free;
}

export async function nextFreeSlot(ctx: Ctx, brand: Brand, excludePostId?: string, db: DbOrTx = ctx.db): Promise<Date> {
  if (!brand.postingSlots.length) {
    throw new AppError("no_free_slot", `Brand '${brand.slug}' has no posting slots configured.`, {
      hint: "Pass an explicit scheduledAt, or add posting slots with update_brand_guidelines.",
    });
  }
  const from = new Date(ctx.now().getTime() + MIN_LEAD_MS);
  const [slot] = await computeFreeSlots(db, brand, from, new Date(from.getTime() + NEXT_SLOT_HORIZON_MS), { limit: 1, excludePostId });
  if (!slot) throw new AppError("no_free_slot", `No free posting slot for '${brand.slug}' in the next 60 days.`, { hint: "Pass an explicit scheduledAt." });
  return slot;
}

export async function getFreeSlots(ctx: Ctx, input: z.input<typeof freeSlotsSchema>) {
  const data = parse(freeSlotsSchema, input);
  const brand = await getAccessibleBrand(ctx, data.brandId);
  assertCan(ctx.actor, "post.read", brand);
  const now = ctx.now();
  const from = data.from ? new Date(data.from) : now;
  const to = data.to ? new Date(data.to) : new Date(from.getTime() + 14 * DAY);
  if (to <= from) throw new AppError("validation_error", "`to` must be after `from`.");
  if (to.getTime() - from.getTime() > 92 * DAY) throw new AppError("validation_error", "Range can be at most 92 days.");
  const effectiveFrom = new Date(Math.max(from.getTime(), now.getTime() + MIN_LEAD_MS));
  const slots = await computeFreeSlots(ctx.db, brand, effectiveFrom, to, { limit: data.limit });
  return {
    brandId: brand.id,
    timezone: brand.timezone,
    slots: slots.map((s) => ({ at: s.toISOString(), local: toZonedIso(s, brand.timezone) })),
  };
}
