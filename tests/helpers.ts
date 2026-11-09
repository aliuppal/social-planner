import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { randomUUID } from "node:crypto";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db";
import { brandMembers, users } from "@/lib/db/schema";
import { systemActor, type Actor, type ApiClientActor, type UserActor } from "@/lib/auth/guard";
import { MockInstagramClient } from "@/lib/instagram/mock";
import { logger } from "@/lib/logger";
import { MemoryQueue, PassthroughMediaStore, withActor, type Ctx, type Deps } from "@/lib/services/context";
import { createBrand } from "@/lib/services/brands";
import { insertApiClient, authenticateApiKey } from "@/lib/services/api-clients";
import type { CreateBrandInput } from "@/lib/schemas/brand";

/** 2026-11-10 10:00 UTC = 15:00 in Asia/Karachi (UTC+5). */
export const T0 = new Date("2026-11-10T10:00:00.000Z");

export class Clock {
  constructor(public current: Date = T0) {}
  now = () => new Date(this.current);
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(d: Date) {
    this.current = new Date(d);
  }
}

export type TestEnv = {
  db: Db;
  clock: Clock;
  ig: MockInstagramClient;
  queue: MemoryQueue;
  deps: Deps;
  ctx: (actor: Actor) => Ctx;
  system: Ctx;
  close: () => Promise<void>;
};

/** Fresh in-process Postgres with the real migrations applied. */
export async function setupEnv(): Promise<TestEnv> {
  const client = new PGlite();
  const pdb = drizzle({ client, schema });
  await migrate(pdb, { migrationsFolder: "drizzle" });
  const db = pdb as unknown as Db;
  const clock = new Clock();
  const ig = new MockInstagramClient(clock.now);
  const queue = new MemoryQueue();
  const deps: Deps = { db, ig, igMode: "mock", queue, media: new PassthroughMediaStore(), now: clock.now, log: logger };
  return {
    db,
    clock,
    ig,
    queue,
    deps,
    ctx: (actor) => withActor(deps, actor),
    system: withActor(deps, systemActor("test")),
    close: () => client.close(),
  };
}

export const KARACHI_17 = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, time: "17:00" }));

export async function makeBrand(env: TestEnv, over: Partial<CreateBrandInput> = {}) {
  return createBrand(env.system, {
    name: "Uppal NQ1",
    slug: "uppal-nq1",
    timezone: "Asia/Karachi",
    postingSlots: KARACHI_17,
    requiresApproval: true,
    ...over,
  });
}

export async function makeUser(env: TestEnv, role: "owner" | "manager" | "client", brandIds: string[] = []): Promise<UserActor> {
  const id = randomUUID();
  await env.db.insert(users).values({ id, name: `${role} user`, email: `${role}-${id.slice(0, 6)}@example.test`, role });
  if (brandIds.length) await env.db.insert(brandMembers).values(brandIds.map((brandId) => ({ brandId, userId: id })));
  return { kind: "user", userId: id, name: `${role} user`, role, brandIds: role === "owner" ? "all" : brandIds };
}

/** Seed-equivalent API clients, authenticated through the real key path. */
export async function makeApiClients(env: TestEnv, brandId: string): Promise<{ hermes: ApiClientActor; inqi: ApiClientActor }> {
  const h = await insertApiClient(env.db, {
    name: "hermes",
    source: "hermes",
    scopes: ["posts:read", "posts:write", "posts:approve", "posts:publish", "brands:read", "brands:write", "insights:read"],
    brandIds: "all",
  });
  const i = await insertApiClient(env.db, { name: "inqi", source: "inqi", scopes: ["posts:read", "posts:approve", "brands:read", "insights:read"], brandIds: [brandId] });
  return { hermes: (await authenticateApiKey(env.db, h.apiKey))!, inqi: (await authenticateApiKey(env.db, i.apiKey))! };
}

export const IMG = "https://cdn.example.test/nq1/snapshot.jpg";
export const IMG2 = "https://cdn.example.test/nq1/snapshot-2.jpg";
export const VIDEO = "https://cdn.example.test/nq1/routine.mp4";
