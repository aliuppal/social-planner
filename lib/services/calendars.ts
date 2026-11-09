import { and, asc, eq, gte, inArray, isNull, lt, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { brands, calendarPosts, calendars, postMedia, posts, type Brand, type Calendar } from "@/lib/db/schema";
import { assertCan, brandScope } from "@/lib/auth/guard";
import { AppError, notFound, parse } from "@/lib/errors";
import { id, isoDate, isoDateTime } from "@/lib/schemas/post";
import { DAY, toZonedIso, zonedDateKey } from "@/lib/time";
import type { Ctx } from "./context";
import { getAccessibleBrand } from "./brands";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour like #8b7bff");

export const calendarView = (c: Calendar) => ({
  id: c.id,
  brandId: c.brandId,
  kind: c.kind,
  name: c.name,
  color: c.color,
  startsOn: c.startsOn,
  endsOn: c.endsOn,
  archived: Boolean(c.archivedAt),
});

async function loadCalendar(ctx: Ctx, calendarId: string) {
  parse(id, calendarId);
  const [cal] = await ctx.db.select().from(calendars).where(eq(calendars.id, calendarId));
  if (!cal) throw notFound("Calendar", calendarId);
  const brand = await getAccessibleBrand(ctx, cal.brandId).catch(() => {
    throw notFound("Calendar", calendarId);
  });
  return { cal, brand };
}

export async function listCalendars(ctx: Ctx, input: { brandId?: string; includeArchived?: boolean } = {}) {
  const data = parse(z.object({ brandId: z.string().optional(), includeArchived: z.boolean().default(false) }), input);
  const scope = brandScope(ctx.actor);
  const where: (SQL | undefined)[] = [data.includeArchived ? undefined : isNull(calendars.archivedAt)];
  if (data.brandId) {
    const b = await getAccessibleBrand(ctx, data.brandId);
    assertCan(ctx.actor, "post.read", b);
    where.push(eq(calendars.brandId, b.id));
  } else if (scope !== "all") {
    if (!scope.length) return [];
    where.push(inArray(calendars.brandId, scope));
  }
  const rows = await ctx.db
    .select({ c: calendars, brandName: brands.name, brandSlug: brands.slug, brandColor: brands.color })
    .from(calendars)
    .innerJoin(brands, eq(brands.id, calendars.brandId))
    .where(and(...where))
    .orderBy(asc(brands.name), asc(calendars.kind), asc(calendars.name));
  return rows.map((r) => ({ ...calendarView(r.c), color: r.c.color ?? r.brandColor, brand: { name: r.brandName, slug: r.brandSlug } }));
}

export const createCalendarSchema = z
  .object({
    brandId: z.string().min(1),
    name: z.string().min(1).max(120),
    color: color.optional(),
    startsOn: isoDate.optional(),
    endsOn: isoDate.optional(),
  })
  .refine((v) => !v.startsOn || !v.endsOn || v.startsOn <= v.endsOn, { message: "endsOn must be on or after startsOn", path: ["endsOn"] });

export async function createCalendar(ctx: Ctx, input: z.input<typeof createCalendarSchema>) {
  const data = parse(createCalendarSchema, input);
  const brand = await getAccessibleBrand(ctx, data.brandId);
  assertCan(ctx.actor, "calendar.write", brand);
  const [c] = await ctx.db.insert(calendars).values({ brandId: brand.id, kind: "custom", name: data.name, color: data.color, startsOn: data.startsOn, endsOn: data.endsOn }).returning();
  return calendarView(c);
}

export const updateCalendarSchema = z.object({
  calendarId: id,
  name: z.string().min(1).max(120).optional(),
  color: color.nullish(),
  startsOn: isoDate.nullish(),
  endsOn: isoDate.nullish(),
  archived: z.boolean().optional(),
});

export async function updateCalendar(ctx: Ctx, input: z.input<typeof updateCalendarSchema>) {
  const data = parse(updateCalendarSchema, input);
  const { cal, brand } = await loadCalendar(ctx, data.calendarId);
  assertCan(ctx.actor, "calendar.write", brand);
  if (cal.kind === "brand" && (data.archived || data.startsOn !== undefined || data.endsOn !== undefined)) {
    throw new AppError("validation_error", "The brand calendar can be renamed or recoloured, not archived or given dates.");
  }
  const [c] = await ctx.db
    .update(calendars)
    .set({
      ...(data.name ? { name: data.name } : {}),
      ...(data.color !== undefined ? { color: data.color } : {}),
      ...(data.startsOn !== undefined ? { startsOn: data.startsOn } : {}),
      ...(data.endsOn !== undefined ? { endsOn: data.endsOn } : {}),
      ...(data.archived !== undefined ? { archivedAt: data.archived ? ctx.now() : null } : {}),
    })
    .where(eq(calendars.id, cal.id))
    .returning();
  return calendarView(c);
}

const membershipSchema = z.object({ calendarId: id, postId: id });

async function loadMembership(ctx: Ctx, input: z.input<typeof membershipSchema>) {
  const data = parse(membershipSchema, input);
  const { cal, brand } = await loadCalendar(ctx, data.calendarId);
  assertCan(ctx.actor, "calendar.write", brand);
  if (cal.kind !== "custom") throw new AppError("validation_error", "Every post is already on its brand calendar; only custom calendars take posts.");
  if (cal.archivedAt) throw new AppError("validation_error", "This calendar is archived.");
  const [p] = await ctx.db.select({ id: posts.id, brandId: posts.brandId }).from(posts).where(eq(posts.id, data.postId));
  if (!p) throw notFound("Post", data.postId);
  if (p.brandId !== cal.brandId) throw new AppError("validation_error", "A post can only be added to calendars of its own brand.");
  return { cal, postId: p.id };
}

export async function addPostToCalendar(ctx: Ctx, input: z.input<typeof membershipSchema>) {
  const { cal, postId } = await loadMembership(ctx, input);
  await ctx.db.insert(calendarPosts).values({ calendarId: cal.id, postId }).onConflictDoNothing();
  await touchPost(ctx, postId);
  return { ok: true, calendarId: cal.id, postId };
}

export async function removePostFromCalendar(ctx: Ctx, input: z.input<typeof membershipSchema>) {
  const { cal, postId } = await loadMembership(ctx, input);
  await ctx.db.delete(calendarPosts).where(and(eq(calendarPosts.calendarId, cal.id), eq(calendarPosts.postId, postId)));
  await touchPost(ctx, postId);
  return { ok: true, calendarId: cal.id, postId };
}

/** Bumps updated_at so open calendars pick the change up on their next poll. */
async function touchPost(ctx: Ctx, postId: string) {
  await ctx.db.update(posts).set({ updatedAt: ctx.now() }).where(eq(posts.id, postId));
}

export const getCalendarSchema = z
  .object({
    calendarId: id.optional(),
    brandId: z.string().optional(),
    from: isoDateTime,
    to: isoDateTime,
    includeCancelled: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.calendarId) !== Boolean(v.brandId), { message: "pass exactly one of calendarId or brandId", path: ["calendarId"] });

/** Posts in a date range, grouped by day in the brand's timezone. Includes published and imported posts. */
export async function getCalendar(ctx: Ctx, input: z.input<typeof getCalendarSchema>) {
  const data = parse(getCalendarSchema, input);
  let brand: Brand;
  let cal: Calendar | undefined;
  if (data.calendarId) ({ cal, brand } = await loadCalendar(ctx, data.calendarId));
  else brand = await getAccessibleBrand(ctx, data.brandId!);
  assertCan(ctx.actor, "post.read", brand);

  const from = new Date(data.from);
  const to = new Date(data.to);
  if (to <= from) throw new AppError("validation_error", "`to` must be after `from`.");
  if (to.getTime() - from.getTime() > 92 * DAY) throw new AppError("validation_error", "Range can be at most 92 days.");

  const at = sql<Date>`coalesce(${posts.publishedAt}, ${posts.scheduledAt})`;
  const rows = await ctx.db
    .select({ p: posts, at: sql<string>`${at}` })
    .from(posts)
    .where(
      and(
        eq(posts.brandId, brand.id),
        gte(at, from),
        lt(at, to),
        data.includeCancelled ? undefined : ne(posts.status, "cancelled"),
        cal?.kind === "custom" ? inArray(posts.id, ctx.db.select({ id: calendarPosts.postId }).from(calendarPosts).where(eq(calendarPosts.calendarId, cal.id))) : undefined,
      ),
    )
    .orderBy(asc(at));

  const ids = rows.map((r) => r.p.id);
  const thumbs = ids.length
    ? await ctx.db.select({ postId: postMedia.postId, url: postMedia.url }).from(postMedia).where(and(inArray(postMedia.postId, ids), eq(postMedia.position, 0)))
    : [];
  const thumbBy = new Map(thumbs.map((t) => [t.postId, t.url]));

  const days: Record<string, unknown[]> = {};
  for (const { p, at: atStr } of rows) {
    const when = new Date(atStr);
    const key = zonedDateKey(when, brand.timezone);
    (days[key] ??= []).push({
      id: p.id,
      type: p.type,
      status: p.status,
      source: p.source,
      at: when.toISOString(),
      local: toZonedIso(when, brand.timezone),
      caption: p.caption.length > 140 ? `${p.caption.slice(0, 140)}…` : p.caption,
      pillar: p.pillar,
      thumbnailUrl: p.thumbnailUrl ?? thumbBy.get(p.id) ?? null,
      permalink: p.permalink,
      version: p.version,
    });
  }
  return {
    brand: { id: brand.id, slug: brand.slug, name: brand.name, timezone: brand.timezone, color: brand.color },
    calendar: cal ? calendarView(cal) : null,
    from: from.toISOString(),
    to: to.toISOString(),
    days,
  };
}
