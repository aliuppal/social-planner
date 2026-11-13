import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { brands, instagramAccounts, postEvents, posts } from "@/lib/db/schema";
import { assertCan, systemActor } from "@/lib/auth/guard";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import type { IgMedia } from "@/lib/instagram/client";
import { sanitizeError } from "@/lib/logger";
import { DAY, HOUR } from "@/lib/time";
import type { Ctx, Deps } from "./context";
import { getAccessibleBrand } from "./brands";
import { composeCaption } from "./media";
import { emitEvent } from "./webhooks";

/** What the OAuth exchange returns (lib/instagram/graph.ts exchangeCode). */
export type IgProfile = { accessToken: string; expiresIn: number; igUserId: string; username: string; accountType: string | null; scopes: string[] };

// ---------- connect / disconnect ----------

/** Store a freshly authorised account for a brand. The token is encrypted at rest and never returned. */
export async function connectAccount(ctx: Ctx, brandId: string, p: IgProfile) {
  const brand = await getAccessibleBrand(ctx, brandId);
  assertCan(ctx.actor, "brand.write", brand);
  const [elsewhere] = await ctx.db
    .select({ brandId: instagramAccounts.brandId })
    .from(instagramAccounts)
    .where(and(eq(instagramAccounts.igUserId, p.igUserId), ne(instagramAccounts.brandId, brand.id), ne(instagramAccounts.status, "disconnected")));
  if (elsewhere) throw new AppError("conflict", `@${p.username} is already connected to another brand. Disconnect it there first.`);

  const now = ctx.now();
  const values = {
    igUserId: p.igUserId,
    username: p.username,
    accountType: p.accountType,
    accessTokenEnc: encryptSecret(p.accessToken),
    tokenExpiresAt: new Date(now.getTime() + p.expiresIn * 1000),
    scopes: p.scopes,
    status: "connected" as const,
    lastRefreshAt: now,
    lastError: null,
    updatedAt: now,
  };
  await ctx.db.insert(instagramAccounts).values({ brandId: brand.id, ...values }).onConflictDoUpdate({ target: instagramAccounts.brandId, set: values });

  const expected = brand.instagramHandle?.toLowerCase();
  return {
    username: p.username,
    accountType: p.accountType,
    warning: expected && expected !== p.username.toLowerCase() ? `This brand expects @${brand.instagramHandle} but you connected @${p.username}.` : undefined,
  };
}

export async function disconnectAccount(ctx: Ctx, brandId: string) {
  const brand = await getAccessibleBrand(ctx, brandId);
  assertCan(ctx.actor, "brand.write", brand);
  // keep the row (sync history) but wipe the token
  await ctx.db.update(instagramAccounts).set({ status: "disconnected", accessTokenEnc: encryptSecret("revoked"), updatedAt: ctx.now() }).where(eq(instagramAccounts.brandId, brand.id));
  return { ok: true };
}

// ---------- token refresh (daily job) ----------

const REFRESH_WHEN_LEFT = 15 * DAY;
const WARN_WHEN_LEFT = 7 * DAY;

export async function refreshTokens(deps: Deps, refresher: (token: string) => Promise<{ access_token: string; expires_in: number }>) {
  const now = deps.now();
  const rows = await deps.db.select().from(instagramAccounts).where(inArray(instagramAccounts.status, ["connected", "error"]));
  const out: { brandId: string; result: "refreshed" | "skipped" | "expired" | "error"; detail?: string }[] = [];
  for (const a of rows) {
    const left = (a.tokenExpiresAt?.getTime() ?? 0) - now.getTime();
    const age = now.getTime() - (a.lastRefreshAt?.getTime() ?? 0);
    if (left <= 0) {
      await deps.db.update(instagramAccounts).set({ status: "expired", lastError: "Token expired; reconnect the account." }).where(eq(instagramAccounts.id, a.id));
      await emitEvent(deps.db, deps, { event: "account.token_expiring", brandId: a.brandId, payload: { brandId: a.brandId, username: a.username, expired: true } });
      out.push({ brandId: a.brandId, result: "expired" });
      continue;
    }
    if (left > REFRESH_WHEN_LEFT || age < 24 * HOUR) {
      out.push({ brandId: a.brandId, result: "skipped" });
      continue;
    }
    try {
      const r = await refresher(decryptSecret(a.accessTokenEnc));
      await deps.db
        .update(instagramAccounts)
        .set({ accessTokenEnc: encryptSecret(r.access_token), tokenExpiresAt: new Date(now.getTime() + r.expires_in * 1000), lastRefreshAt: now, status: "connected", lastError: null })
        .where(eq(instagramAccounts.id, a.id));
      out.push({ brandId: a.brandId, result: "refreshed" });
    } catch (err) {
      const msg = sanitizeError(err);
      await deps.db.update(instagramAccounts).set({ status: "error", lastError: `Token refresh failed: ${msg}` }).where(eq(instagramAccounts.id, a.id));
      if (left < WARN_WHEN_LEFT) {
        await emitEvent(deps.db, deps, { event: "account.token_expiring", brandId: a.brandId, payload: { brandId: a.brandId, username: a.username, expiresAt: a.tokenExpiresAt?.toISOString(), error: msg } });
      }
      out.push({ brandId: a.brandId, result: "error", detail: msg });
    }
  }
  return out;
}

// ---------- import sync (every 30 min) ----------

const mediaType = (m: IgMedia) => (m.mediaType === "CAROUSEL_ALBUM" ? "carousel" : m.mediaType === "VIDEO" ? "reel" : "image") as "image" | "carousel" | "reel";

/**
 * Bring the brand's recent Instagram posts into the planner:
 * - posts we published but couldn't confirm are linked by caption
 * - anything else (posted in the Instagram app) is imported as published, source=instagram
 */
export async function syncBrand(deps: Deps, brandId: string) {
  const [acct] = await deps.db.select().from(instagramAccounts).where(and(eq(instagramAccounts.brandId, brandId), eq(instagramAccounts.status, "connected")));
  if (!acct) return { brandId, imported: 0, linked: 0, skipped: "not connected" };
  const auth = { igUserId: acct.igUserId, accessToken: decryptSecret(acct.accessTokenEnc) };
  const since = new Date((acct.lastSyncedAt ?? new Date(deps.now().getTime() - 30 * DAY)).getTime() - DAY);
  const media = await deps.ig.listRecentMedia(auth, { limit: 50, since });
  let imported = 0;
  let linked = 0;

  for (const m of media) {
    if (m.mediaProductType === "STORY") continue;
    const [known] = await deps.db.select({ id: posts.id }).from(posts).where(and(eq(posts.brandId, brandId), eq(posts.igMediaId, m.id)));
    if (known) continue;

    const unconfirmed = await deps.db
      .select()
      .from(posts)
      .where(and(eq(posts.brandId, brandId), isNull(posts.igMediaId), or(eq(posts.status, "published"), eq(posts.status, "publishing"))));
    const match = unconfirmed.find((p) => composeCaption(p).trim() === (m.caption ?? "").trim());
    if (match) {
      await deps.db.update(posts).set({ igMediaId: m.id, permalink: m.permalink ?? null, publishedAt: m.timestamp, lastError: null, updatedAt: deps.now() }).where(eq(posts.id, match.id));
      linked++;
      continue;
    }

    await deps.db.transaction(async (tx) => {
      const [p] = await tx
        .insert(posts)
        .values({
          brandId,
          type: mediaType(m),
          status: "published",
          source: "instagram",
          caption: m.caption ?? "",
          igMediaId: m.id,
          permalink: m.permalink ?? null,
          thumbnailUrl: m.thumbnailUrl ?? m.mediaUrl ?? null,
          publishedAt: m.timestamp,
          createdAt: deps.now(),
          updatedAt: deps.now(),
        })
        .onConflictDoNothing()
        .returning();
      if (p) {
        await tx.insert(postEvents).values({ postId: p.id, kind: "transition", toStatus: "published", actorType: "system", actorName: systemActor("instagram-sync").name, comment: "Imported from Instagram (posted outside the planner)", createdAt: deps.now() });
        imported++;
      }
    });
  }
  await deps.db.update(instagramAccounts).set({ lastSyncedAt: deps.now() }).where(eq(instagramAccounts.id, acct.id));
  return { brandId, imported, linked };
}

export async function syncAllBrands(deps: Deps) {
  const rows = await deps.db
    .select({ brandId: instagramAccounts.brandId })
    .from(instagramAccounts)
    .innerJoin(brands, eq(brands.id, instagramAccounts.brandId))
    .where(and(eq(instagramAccounts.status, "connected"), isNull(brands.archivedAt)));
  const out = [];
  for (const r of rows) {
    try {
      out.push(await syncBrand(deps, r.brandId));
    } catch (err) {
      deps.log.warn({ brandId: r.brandId, err: sanitizeError(err) }, "instagram sync failed");
      out.push({ brandId: r.brandId, error: sanitizeError(err) });
    }
  }
  return out;
}
