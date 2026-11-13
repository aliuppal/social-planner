import { and, count, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { brands, postInsights, posts } from "@/lib/db/schema";
import { brandScope } from "@/lib/auth/guard";
import { toZonedIso } from "@/lib/time";
import type { Ctx } from "./context";
import { listPosts } from "./posts";

/**
 * Calendar feed for the web UI: every post in range for the chosen scope, with its brand's
 * colour/timezone, local wall-clock time, thumbnail and latest metrics (published posts).
 */
export async function calendarFeed(ctx: Ctx, input: { from: string; to: string; brandId?: string; calendarId?: string }) {
  const items: Awaited<ReturnType<typeof listPosts>>["posts"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await listPosts(ctx, { from: input.from, to: input.to, brandId: input.brandId, calendarId: input.calendarId, limit: 200, cursor });
    items.push(...r.posts);
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  const visible = items.filter((p) => p.scheduledAt || p.publishedAt);

  const brandIds = [...new Set(visible.map((p) => p.brandId))];
  const brandRows = brandIds.length ? await ctx.db.select({ id: brands.id, name: brands.name, slug: brands.slug, color: brands.color, timezone: brands.timezone }).from(brands).where(inArray(brands.id, brandIds)) : [];
  const brandBy = new Map(brandRows.map((b) => [b.id, b]));

  const publishedIds = visible.filter((p) => p.status === "published").map((p) => p.id);
  const metrics = publishedIds.length
    ? await ctx.db
        .selectDistinctOn([postInsights.postId], { postId: postInsights.postId, reach: postInsights.reach, likes: postInsights.likes, comments: postInsights.comments, saves: postInsights.saves, shares: postInsights.shares })
        .from(postInsights)
        .where(inArray(postInsights.postId, publishedIds))
        .orderBy(postInsights.postId, desc(postInsights.capturedAt))
    : [];
  const metricsBy = new Map(metrics.map((m) => [m.postId, m]));

  return visible.map((p) => {
    const b = brandBy.get(p.brandId)!;
    const at = new Date(p.publishedAt ?? p.scheduledAt!);
    const local = toZonedIso(at, b.timezone);
    return {
      id: p.id,
      brandId: p.brandId,
      brand: { name: b.name, slug: b.slug, color: b.color, timezone: b.timezone },
      type: p.type,
      status: p.status,
      source: p.source,
      caption: p.caption.length > 160 ? `${p.caption.slice(0, 160)}…` : p.caption,
      at: at.toISOString(),
      /** wall-clock in the brand timezone without offset, e.g. 2026-11-10T17:00:00 */
      wall: local.slice(0, 19),
      local,
      thumbnailUrl: p.thumbnailUrl,
      permalink: p.permalink,
      version: p.version,
      lastError: p.lastError,
      metrics: metricsBy.get(p.id) ?? null,
    };
  });
}

export type FeedItem = Awaited<ReturnType<typeof calendarFeed>>[number];

/** Cheap change detector for live refresh: latest post update + post count across the user's brands. */
export async function getChangeCursor(ctx: Ctx): Promise<string> {
  const scope = brandScope(ctx.actor);
  if (scope !== "all" && !scope.length) return "empty";
  const [r] = await ctx.db
    .select({ last: max(posts.updatedAt), n: count() })
    .from(posts)
    .innerJoin(brands, eq(brands.id, posts.brandId))
    .where(and(isNull(brands.archivedAt), scope === "all" ? undefined : inArray(posts.brandId, scope)));
  return `${r.last ? new Date(r.last).toISOString() : "0"}|${r.n}`;
}
