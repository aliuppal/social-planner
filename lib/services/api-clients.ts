import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/lib/db";
import { apiClientBrands, apiClients, type ApiClient } from "@/lib/db/schema";
import { SCOPES, assertCan, type ApiClientActor, type Scope } from "@/lib/auth/guard";
import { generateApiKey, parseApiKey, safeEqualHex, sha256 } from "@/lib/crypto";
import { AppError, notFound, parse } from "@/lib/errors";
import { id } from "@/lib/schemas/post";
import type { Ctx } from "./context";

export const createApiClientSchema = z.object({
  name: z.string().min(2).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase name like hermes or inqi"),
  /** which source badge posts created by this client get */
  source: z.enum(["hermes", "inqi", "api"]).default("api"),
  scopes: z.array(z.enum(SCOPES)).min(1),
  brandIds: z.union([z.literal("all"), z.array(id)]).default([]),
});

const view = (c: ApiClient, brandIds: string[] | "all") => ({
  id: c.id,
  name: c.name,
  source: c.source,
  keyPrefix: `sp_live_${c.keyPrefix}_…`,
  scopes: c.scopes,
  brandIds,
  revoked: Boolean(c.revokedAt),
  lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
});

/** Low-level create (no actor check): used by the seed and by createApiClient. Returns the key once. */
export async function insertApiClient(db: Db, input: z.input<typeof createApiClientSchema>) {
  const data = parse(createApiClientSchema, input);
  const { key, prefix, hash } = generateApiKey();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: apiClients.id }).from(apiClients).where(eq(apiClients.name, data.name));
    if (existing) throw new AppError("conflict", `An API client named '${data.name}' already exists`, { hint: "Rotate its key instead." });
    const [c] = await tx
      .insert(apiClients)
      .values({ name: data.name, source: data.source, keyPrefix: prefix, keyHash: hash, scopes: data.scopes, allBrands: data.brandIds === "all" })
      .returning();
    if (data.brandIds !== "all" && data.brandIds.length) {
      await tx.insert(apiClientBrands).values(data.brandIds.map((brandId) => ({ apiClientId: c.id, brandId })));
    }
    return { client: view(c, data.brandIds), apiKey: key };
  });
}

export async function createApiClient(ctx: Ctx, input: z.input<typeof createApiClientSchema>) {
  assertCan(ctx.actor, "admin");
  return insertApiClient(ctx.db, input);
}

export async function listApiClients(ctx: Ctx) {
  assertCan(ctx.actor, "admin");
  const rows = await ctx.db.select().from(apiClients).orderBy(asc(apiClients.name));
  const links = await ctx.db.select().from(apiClientBrands);
  return rows.map((c) => view(c, c.allBrands ? "all" : links.filter((l) => l.apiClientId === c.id).map((l) => l.brandId)));
}

/** New key; the old key stops working immediately. Returns the new key once. */
export async function rotateApiClientKey(db: Db, clientId: string) {
  const { key, prefix, hash } = generateApiKey();
  const [c] = await db.update(apiClients).set({ keyPrefix: prefix, keyHash: hash, revokedAt: null }).where(eq(apiClients.id, clientId)).returning();
  if (!c) throw notFound("API client", clientId);
  return { apiKey: key, keyPrefix: `sp_live_${prefix}_…` };
}

export async function rotateKey(ctx: Ctx, clientId: string) {
  assertCan(ctx.actor, "admin");
  return rotateApiClientKey(ctx.db, parse(id, clientId));
}

export async function revokeApiClient(ctx: Ctx, clientId: string) {
  assertCan(ctx.actor, "admin");
  const [c] = await ctx.db.update(apiClients).set({ revokedAt: ctx.now() }).where(eq(apiClients.id, parse(id, clientId))).returning();
  if (!c) throw notFound("API client", clientId);
  return { ok: true };
}

/** Resolve `Authorization: Bearer <key>` to an actor, or null. Constant-time hash comparison. */
export async function authenticateApiKey(db: Db, rawKey: string | null | undefined, now = new Date()): Promise<ApiClientActor | null> {
  if (!rawKey) return null;
  const parsed = parseApiKey(rawKey);
  if (!parsed) return null;
  const [c] = await db.select().from(apiClients).where(eq(apiClients.keyPrefix, parsed.prefix));
  if (!c || c.revokedAt || !safeEqualHex(c.keyHash, sha256(rawKey.trim()))) return null;
  const brandIds = c.allBrands
    ? ("all" as const)
    : (await db.select({ b: apiClientBrands.brandId }).from(apiClientBrands).where(eq(apiClientBrands.apiClientId, c.id))).map((r) => r.b);
  await db.update(apiClients).set({ lastUsedAt: now }).where(eq(apiClients.id, c.id));
  return { kind: "api_client", clientId: c.id, name: c.name, source: c.source, scopes: c.scopes as Scope[], brandIds };
}
