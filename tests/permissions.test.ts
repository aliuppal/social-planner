import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCOPES, can, type Action, type ApiClientActor, type Scope, type UserActor } from "@/lib/auth/guard";
import { authenticateApiKey, insertApiClient } from "@/lib/services/api-clients";
import { getBrand, listBrands, updateBrandGuidelines } from "@/lib/services/brands";
import { listCalendars } from "@/lib/services/calendars";
import { approvePost, createPost, getPost, listPosts, publishNow, schedulePost, submitForApproval } from "@/lib/services/posts";
import { IMG, makeApiClients, makeBrand, makeUser, setupEnv, type TestEnv } from "./helpers";

const B = { id: "b1", clientsCanSchedule: false };
const apiActor = (scopes: Scope[], brandIds: string[] | "all" = "all"): ApiClientActor => ({ kind: "api_client", clientId: "c", name: "test-key", source: "api", scopes, brandIds });
const userActor = (role: UserActor["role"], brandIds: string[] | "all" = ["b1"]): UserActor => ({ kind: "user", userId: "u", name: "u", role, brandIds });

describe("scope → action matrix for API keys", () => {
  const cases: [Action, Scope][] = [
    ["post.read", "posts:read"],
    ["post.create", "posts:write"],
    ["post.edit", "posts:write"],
    ["post.schedule", "posts:write"],
    ["post.approve", "posts:approve"],
    ["post.publish", "posts:publish"],
    ["brand.read", "brands:read"],
    ["brand.write", "brands:write"],
    ["insights.read", "insights:read"],
  ];
  it.each(cases)("%s needs %s", (action, scope) => {
    expect(can(apiActor([scope]), action, B).ok).toBe(true);
    const d = can(apiActor(SCOPES.filter((s) => s !== scope)), action, B);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain(scope);
  });

  it("comment is allowed with posts:write or posts:approve", () => {
    expect(can(apiActor(["posts:approve"]), "post.comment", B).ok).toBe(true);
    expect(can(apiActor(["posts:write"]), "post.comment", B).ok).toBe(true);
    expect(can(apiActor(["posts:read"]), "post.comment", B).ok).toBe(false);
  });

  it("never grants admin to API keys, even with every scope", () => {
    expect(can(apiActor([...SCOPES]), "admin").ok).toBe(false);
  });

  it("enforces the brand allow-list", () => {
    expect(can(apiActor(["posts:read"], ["b2"]), "post.read", B).ok).toBe(false);
    expect(can(apiActor(["posts:read"], ["b1"]), "post.read", B).ok).toBe(true);
  });
});

describe("role matrix for users", () => {
  it("owner can do everything, manager everything but admin", () => {
    expect(can(userActor("owner", "all"), "admin").ok).toBe(true);
    expect(can(userActor("manager"), "admin").ok).toBe(false);
    for (const a of ["post.create", "post.approve", "post.schedule", "post.publish", "brand.write"] as Action[]) expect(can(userActor("manager"), a, B).ok).toBe(true);
  });

  it("client can read, approve and comment; creating/scheduling depends on the brand flag", () => {
    const c = userActor("client");
    for (const a of ["post.read", "post.approve", "post.comment", "brand.read", "insights.read"] as Action[]) expect(can(c, a, B).ok).toBe(true);
    for (const a of ["post.create", "post.schedule", "calendar.write"] as Action[]) {
      expect(can(c, a, B).ok).toBe(false);
      expect(can(c, a, { ...B, clientsCanSchedule: true }).ok).toBe(true);
    }
    expect(can(c, "post.publish", { ...B, clientsCanSchedule: true }).ok).toBe(false);
    expect(can(c, "brand.write", B).ok).toBe(false);
  });

  it("users only reach brands they belong to", () => {
    expect(can(userActor("manager", ["b2"]), "post.read", B).ok).toBe(false);
  });
});

describe("permissions through the services", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setupEnv();
  });
  afterEach(async () => env.close());

  it("inqi (read/approve key) can't create, schedule or publish posts", async () => {
    const brand = await makeBrand(env);
    const { hermes, inqi } = await makeApiClients(env, brand.id);
    await expect(createPost(env.ctx(inqi), { brandId: brand.id, type: "image" })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("posts:write") });
    const post = await createPost(env.ctx(hermes), { brandId: brand.id, type: "image", media: [{ url: IMG }] });
    await submitForApproval(env.ctx(hermes), { postId: post.id });
    await approvePost(env.ctx(inqi), { postId: post.id });
    await expect(schedulePost(env.ctx(inqi), { postId: post.id, nextFreeSlot: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(publishNow(env.ctx(inqi), { postId: post.id })).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("posts:publish") });
    await expect(updateBrandGuidelines(env.ctx(inqi), { brandId: brand.id, guidelines: { voice: "x" } })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a brand-restricted key can't see other brands (and gets not_found, not forbidden)", async () => {
    const mine = await makeBrand(env);
    const other = await makeBrand(env, { slug: "client-co", name: "Client Co" });
    const { hermes, inqi } = await makeApiClients(env, mine.id);
    const secret = await createPost(env.ctx(hermes), { brandId: other.id, type: "image", caption: "other brand" });

    expect((await listBrands(env.ctx(inqi))).map((b) => b.slug)).toEqual(["uppal-nq1"]);
    await expect(getBrand(env.ctx(inqi), "client-co")).rejects.toMatchObject({ code: "not_found" });
    await expect(getPost(env.ctx(inqi), secret.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await listPosts(env.ctx(inqi), {})).posts).toHaveLength(0);
    expect((await listCalendars(env.ctx(inqi))).every((c) => c.brandId === mine.id)).toBe(true);
  });

  it("a client user sees only their brands' calendars and posts", async () => {
    const mine = await makeBrand(env, { slug: "client-a", name: "Client A" });
    const other = await makeBrand(env, { slug: "client-b", name: "Client B" });
    const owner = await makeUser(env, "owner");
    const client = await makeUser(env, "client", [mine.id]);
    await createPost(env.ctx(owner), { brandId: mine.id, type: "image", caption: "A" });
    await createPost(env.ctx(owner), { brandId: other.id, type: "image", caption: "B" });

    expect((await listCalendars(env.ctx(client))).map((c) => c.brand.slug)).toEqual(["client-a"]);
    expect((await listPosts(env.ctx(client), {})).posts.map((p) => p.caption)).toEqual(["A"]);
    await expect(createPost(env.ctx(client), { brandId: mine.id, type: "image" })).rejects.toMatchObject({ code: "forbidden", opts: { hint: expect.stringContaining("clients can schedule") } });
  });

  it("a client can create and schedule when the brand allows it", async () => {
    const brand = await makeBrand(env, { slug: "client-sched", clientsCanSchedule: true, requiresApproval: false });
    const client = await makeUser(env, "client", [brand.id]);
    const post = await createPost(env.ctx(client), { brandId: brand.id, type: "image", media: [{ url: IMG }] });
    const s = await schedulePost(env.ctx(client), { postId: post.id, scheduledAt: new Date(env.clock.now().getTime() + 5 * 60_000).toISOString() });
    expect(s.status).toBe("scheduled");
  });

  it("rejects unknown, malformed and tampered API keys", async () => {
    const { apiKey } = await insertApiClient(env.db, { name: "temp", scopes: ["posts:read"], brandIds: "all" });
    expect(await authenticateApiKey(env.db, apiKey)).not.toBeNull();
    expect(await authenticateApiKey(env.db, apiKey.slice(0, -2) + "xx")).toBeNull();
    expect(await authenticateApiKey(env.db, "not-a-key")).toBeNull();
    expect(await authenticateApiKey(env.db, undefined)).toBeNull();
  });
});
