import { and, asc, desc, eq, gte, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { brandInsights, postInsights, posts } from "@/lib/db/schema";
import { assertCan } from "@/lib/auth/guard";
import { AppError, notFound, parse } from "@/lib/errors";
import { id, isoDateTime } from "@/lib/schemas/post";
import { DAY } from "@/lib/time";
import type { Ctx } from "./context";
import { getAccessibleBrand } from "./brands";

/**
 * Reads stored metric snapshots. The daily collector that fills them from Instagram lands in phase 6;
 * until then these return empty results rather than errors.
 */

const metricCols = { reach: postInsights.reach, likes: postInsights.likes, comments: postInsights.comments, saves: postInsights.saves, shares: postInsights.shares, views: postInsights.views };

export async function getPostInsights(ctx: Ctx, input: { postId: string; limit?: number }) {
  const data = parse(z.object({ postId: id, limit: z.number().int().min(1).max(90).default(30) }), input);
  const [p] = await ctx.db.select({ id: posts.id, brandId: posts.brandId, status: posts.status, publishedAt: posts.publishedAt, permalink: posts.permalink }).from(posts).where(eq(posts.id, data.postId));
  if (!p) throw notFound("Post", data.postId);
  const brand = await getAccessibleBrand(ctx, p.brandId).catch(() => {
    throw notFound("Post", data.postId);
  });
  assertCan(ctx.actor, "insights.read", brand);
  const snaps = await ctx.db
    .select({ capturedAt: postInsights.capturedAt, ...metricCols })
    .from(postInsights)
    .where(eq(postInsights.postId, p.id))
    .orderBy(desc(postInsights.capturedAt))
    .limit(data.limit);
  const history = snaps.map((s) => ({ ...s, capturedAt: s.capturedAt.toISOString() }));
  return {
    postId: p.id,
    status: p.status,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    permalink: p.permalink,
    latest: history[0] ?? null,
    history,
    note: p.status !== "published" ? "Insights exist only for published posts." : history.length ? undefined : "No snapshots yet; metrics are collected daily.",
  };
}

export const brandInsightsSchema = z.object({ brandId: z.string().min(1), from: isoDateTime.optional(), to: isoDateTime.optional(), top: z.number().int().min(1).max(20).default(5) });

export async function getBrandInsights(ctx: Ctx, input: z.input<typeof brandInsightsSchema>) {
  const data = parse(brandInsightsSchema, input);
  const brand = await getAccessibleBrand(ctx, data.brandId);
  assertCan(ctx.actor, "insights.read", brand);
  const to = data.to ? new Date(data.to) : ctx.now();
  const from = data.from ? new Date(data.from) : new Date(to.getTime() - 30 * DAY);
  if (to <= from) throw new AppError("validation_error", "`to` must be after `from`.");

  // latest snapshot per post
  const latest = ctx.db
    .selectDistinctOn([postInsights.postId], { postId: postInsights.postId, ...metricCols })
    .from(postInsights)
    .orderBy(postInsights.postId, desc(postInsights.capturedAt))
    .as("latest");
  const rows = await ctx.db
    .select({
      id: posts.id,
      type: posts.type,
      caption: posts.caption,
      permalink: posts.permalink,
      publishedAt: posts.publishedAt,
      reach: latest.reach,
      likes: latest.likes,
      comments: latest.comments,
      saves: latest.saves,
      shares: latest.shares,
      views: latest.views,
    })
    .from(posts)
    .leftJoin(latest, eq(latest.postId, posts.id))
    .where(and(eq(posts.brandId, brand.id), eq(posts.status, "published"), gte(posts.publishedAt, from), lt(posts.publishedAt, to)));

  type Row = (typeof rows)[number];
  type Metric = "reach" | "likes" | "comments" | "saves" | "shares" | "views";
  const sum = (k: Metric) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  const brief = (r: Row) => ({ id: r.id, type: r.type, caption: r.caption.slice(0, 100), permalink: r.permalink, publishedAt: r.publishedAt?.toISOString() ?? null, reach: r.reach, saves: r.saves, shares: r.shares, likes: r.likes });
  const topBy = (k: "saves" | "shares" | "reach") => rows.filter((r) => r[k] != null).sort((a, b) => (b[k] ?? 0) - (a[k] ?? 0)).slice(0, data.top).map(brief);

  const followers = await ctx.db
    .select({ day: brandInsights.capturedOn, followers: brandInsights.followersCount })
    .from(brandInsights)
    .where(and(eq(brandInsights.brandId, brand.id), gte(brandInsights.capturedOn, from.toISOString().slice(0, 10)), lte(brandInsights.capturedOn, to.toISOString().slice(0, 10))))
    .orderBy(asc(brandInsights.capturedOn));

  return {
    brand: { id: brand.id, slug: brand.slug },
    from: from.toISOString(),
    to: to.toISOString(),
    publishedPosts: rows.length,
    totals: { reach: sum("reach"), likes: sum("likes"), comments: sum("comments"), saves: sum("saves"), shares: sum("shares"), views: sum("views") },
    followers,
    top: { bySaves: topBy("saves"), byShares: topBy("shares"), byReach: topBy("reach") },
  };
}
