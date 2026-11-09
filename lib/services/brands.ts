import { and, asc, count, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/lib/db";
import { brands, calendars, instagramAccounts, posts, type Brand } from "@/lib/db/schema";
import { assertCan, brandScope } from "@/lib/auth/guard";
import { AppError, notFound, parse } from "@/lib/errors";
import { brandGuidelinesSchema, createBrandSchema, postingSlotSchema, updateBrandSchema } from "@/lib/schemas/brand";
import { id } from "@/lib/schemas/post";
import { MINUTE } from "@/lib/time";
import type { Ctx } from "./context";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Load a brand by id or slug without permission checks (internal). */
export async function findBrand(db: DbOrTx, idOrSlug: string): Promise<Brand | undefined> {
  const where = UUID_RE.test(idOrSlug) ? eq(brands.id, idOrSlug) : eq(brands.slug, idOrSlug);
  const [b] = await db.select().from(brands).where(where);
  return b;
}

/** Load a brand the actor may access, else not_found (never leaks existence). */
export async function getAccessibleBrand(ctx: Ctx, idOrSlug: string, db: DbOrTx = ctx.db): Promise<Brand> {
  const b = await findBrand(db, idOrSlug);
  const scope = brandScope(ctx.actor);
  if (!b || (scope !== "all" && !scope.includes(b.id))) throw notFound("Brand", idOrSlug);
  return b;
}

/** Public view: never includes tokens. */
export function brandView(b: Brand, account?: { username: string; status: string; tokenExpiresAt: Date | null } | null) {
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    timezone: b.timezone,
    instagramHandle: b.instagramHandle ? `@${b.instagramHandle}` : null,
    color: b.color,
    guidelines: b.guidelines,
    postingSlots: b.postingSlots,
    requiresApproval: b.requiresApproval,
    clientsCanSchedule: b.clientsCanSchedule,
    archived: Boolean(b.archivedAt),
    instagram: account ? { username: account.username, status: account.status, tokenExpiresAt: account.tokenExpiresAt?.toISOString() ?? null } : null,
  };
}

async function accountFor(db: DbOrTx, brandId: string) {
  const [a] = await db
    .select({ username: instagramAccounts.username, status: instagramAccounts.status, tokenExpiresAt: instagramAccounts.tokenExpiresAt })
    .from(instagramAccounts)
    .where(eq(instagramAccounts.brandId, brandId));
  return a ?? null;
}

export async function createBrand(ctx: Ctx, input: z.input<typeof createBrandSchema>) {
  assertCan(ctx.actor, "admin");
  const data = parse(createBrandSchema, input);
  return ctx.db.transaction(async (tx) => {
    if (await findBrand(tx, data.slug)) throw new AppError("conflict", `A brand with slug '${data.slug}' already exists`);
    const [b] = await tx.insert(brands).values(data).returning();
    await tx.insert(calendars).values({ brandId: b.id, kind: "brand", name: b.name, color: b.color });
    return brandView(b);
  });
}

export async function listBrands(ctx: Ctx, opts: { includeArchived?: boolean } = {}) {
  const scope = brandScope(ctx.actor);
  if (scope !== "all" && scope.length === 0) return [];
  const rows = await ctx.db
    .select({ b: brands, username: instagramAccounts.username, status: instagramAccounts.status, tokenExpiresAt: instagramAccounts.tokenExpiresAt })
    .from(brands)
    .leftJoin(instagramAccounts, eq(instagramAccounts.brandId, brands.id))
    .where(and(scope === "all" ? undefined : inArray(brands.id, scope), opts.includeArchived ? undefined : isNull(brands.archivedAt)))
    .orderBy(asc(brands.name));
  return rows.map((r) => brandView(r.b, r.username ? { username: r.username, status: r.status!, tokenExpiresAt: r.tokenExpiresAt } : null));
}

export async function getBrand(ctx: Ctx, idOrSlug: string) {
  const b = await getAccessibleBrand(ctx, idOrSlug);
  assertCan(ctx.actor, "brand.read", b);
  return brandView(b, await accountFor(ctx.db, b.id));
}

export async function updateBrand(ctx: Ctx, input: { brandId: string } & z.input<typeof updateBrandSchema>) {
  const { brandId, ...rest } = input;
  const b = await getAccessibleBrand(ctx, parse(id, brandId));
  assertCan(ctx.actor, "brand.write", b);
  const data = parse(updateBrandSchema, rest);
  const [u] = await ctx.db.update(brands).set(data).where(eq(brands.id, b.id)).returning();
  return brandView(u, await accountFor(ctx.db, b.id));
}

export const updateGuidelinesSchema = z.object({
  brandId: z.string().min(1),
  guidelines: brandGuidelinesSchema,
  /** merge (default) keeps keys you don't send; replace overwrites the whole object */
  mode: z.enum(["merge", "replace"]).default("merge"),
  postingSlots: z.array(postingSlotSchema).max(50).optional(),
});

export async function updateBrandGuidelines(ctx: Ctx, input: z.input<typeof updateGuidelinesSchema>) {
  const data = parse(updateGuidelinesSchema, input);
  const b = await getAccessibleBrand(ctx, data.brandId);
  assertCan(ctx.actor, "brand.write", b);
  const guidelines = data.mode === "merge" ? { ...b.guidelines, ...data.guidelines } : data.guidelines;
  const [u] = await ctx.db
    .update(brands)
    .set({ guidelines, ...(data.postingSlots ? { postingSlots: data.postingSlots } : {}) })
    .where(eq(brands.id, b.id))
    .returning();
  return brandView(u, await accountFor(ctx.db, b.id));
}

/** Health of a brand for agents and the status panel. */
export async function getBrandStatus(ctx: Ctx, idOrSlug: string) {
  const b = await getAccessibleBrand(ctx, idOrSlug);
  assertCan(ctx.actor, "brand.read", b);
  const now = ctx.now();
  const [acct] = await ctx.db.select().from(instagramAccounts).where(eq(instagramAccounts.brandId, b.id));
  const failed = await ctx.db
    .select({ id: posts.id, lastError: posts.lastError, scheduledAt: posts.scheduledAt })
    .from(posts)
    .where(and(eq(posts.brandId, b.id), eq(posts.status, "failed")))
    .limit(20);
  const [missed] = await ctx.db
    .select({ n: count() })
    .from(posts)
    .where(and(eq(posts.brandId, b.id), eq(posts.status, "scheduled"), lt(posts.scheduledAt, new Date(now.getTime() - 5 * MINUTE))));
  const [byStatus] = await ctx.db
    .select({
      scheduled: sql<number>`count(*) filter (where ${posts.status} = 'scheduled')`.mapWith(Number),
      awaitingApproval: sql<number>`count(*) filter (where ${posts.status} = 'awaiting_approval')`.mapWith(Number),
    })
    .from(posts)
    .where(eq(posts.brandId, b.id));

  const tokenDaysLeft = acct?.tokenExpiresAt ? Math.floor((acct.tokenExpiresAt.getTime() - now.getTime()) / (24 * 60 * MINUTE)) : null;
  return {
    brand: { id: b.id, slug: b.slug, name: b.name, timezone: b.timezone },
    instagram: acct
      ? {
          connected: acct.status === "connected",
          username: acct.username,
          status: acct.status,
          tokenExpiresAt: acct.tokenExpiresAt?.toISOString() ?? null,
          tokenDaysLeft,
          lastError: acct.lastError,
          publishQuota: acct.quotaTotal != null ? { used: acct.quotaUsed ?? 0, total: acct.quotaTotal, remaining: acct.quotaTotal - (acct.quotaUsed ?? 0), checkedAt: acct.quotaCheckedAt?.toISOString() ?? null } : null,
          lastSyncedAt: acct.lastSyncedAt?.toISOString() ?? null,
        }
      : { connected: false, status: "not_connected" as const },
    counts: { scheduled: byStatus.scheduled, awaitingApproval: byStatus.awaitingApproval, failed: failed.length, missed: missed.n },
    failedPosts: failed.map((f) => ({ id: f.id, error: f.lastError, scheduledAt: f.scheduledAt?.toISOString() ?? null })),
  };
}
