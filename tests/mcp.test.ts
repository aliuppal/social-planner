import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertApiClient } from "@/lib/services/api-clients";
import { handleMcpRequest } from "@/lib/mcp/server";
import { restCallTool } from "@/lib/mcp/rest";
import { TOOLS } from "@/lib/mcp/tools";
import { publishPost } from "@/lib/services/publisher";
import { IMG, makeBrand, setupEnv, type TestEnv } from "./helpers";

const URL_ = "http://planner.test/api/mcp";
type ToolError = { code: string; message: string; details?: { field?: string; message: string }[]; hint?: string };

describe("MCP server", () => {
  let env: TestEnv;
  let keys: { hermes: string; inqi: string };
  const clients: Client[] = [];

  beforeEach(async () => {
    env = await setupEnv();
    const brand = await makeBrand(env, {
      guidelines: { voice: "Calm, honest, no hype", pillars: ["Trade snapshots", "Daily routine"], hashtagSets: { core: ["#NQ1"] } },
    });
    await makeBrand(env, { slug: "other-client", name: "Other Client" });
    const all = ["posts:read", "posts:write", "posts:approve", "posts:publish", "brands:read", "brands:write", "insights:read"] as const;
    keys = {
      hermes: (await insertApiClient(env.db, { name: "hermes", source: "hermes", scopes: [...all], brandIds: "all" })).apiKey,
      inqi: (await insertApiClient(env.db, { name: "inqi", source: "inqi", scopes: ["posts:read", "posts:approve", "brands:read", "insights:read"], brandIds: [brand.id] })).apiKey,
    };
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await env.close();
  });

  const mcpFetch = (url: string | URL, init?: RequestInit) => handleMcpRequest(new Request(url, init), env.deps);

  async function connect(key: string) {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: mcpFetch, requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    clients.push(client);
    return client;
  }

  /** Call a tool and return parsed JSON; `error` is set when the tool returned isError. */
  async function call<T = Record<string, unknown>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ data?: T; error?: ToolError }> {
    const res = await client.callTool({ name, arguments: args });
    const json = JSON.parse((res.content as { type: string; text: string }[])[0].text);
    return res.isError ? { error: json.error } : { data: json };
  }

  it("lists every tool with a JSON Schema and scope", async () => {
    const c = await connect(keys.hermes);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(tools.length).toBe(29); // the 28 tools in the spec + add_comment
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description).toMatch(/Requires scope: /);
    }
    const schedule = tools.find((t) => t.name === "schedule_post")!;
    expect(Object.keys(schedule.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["postId", "scheduledAt", "nextFreeSlot"]));
  });

  it("acceptance: hermes creates and schedules, inqi approves, it publishes with permalink and audit trail", async () => {
    const hermes = await connect(keys.hermes);
    const inqi = await connect(keys.inqi);

    const created = await call<{ id: string; status: string; source: string; warnings: unknown[] }>(hermes, "create_post", {
      brand: "uppal-nq1",
      type: "image",
      caption: "Waited for the retest. One clean NQ1 trade, then done.",
      hashtags: ["NQ1", "#DayTrading"],
      isAiGenerated: true,
      media: [{ url: IMG, altText: "NQ1 5-minute chart with entry marked" }],
    });
    expect(created.data).toMatchObject({ status: "draft", source: "hermes", warnings: [] });
    const postId = created.data!.id;

    expect((await call(hermes, "submit_for_approval", { postId })).data).toMatchObject({ status: "awaiting_approval" });
    expect((await call(inqi, "approve_post", { postId, comment: "Approved from the portal", actingUser: { id: "inqi-7", name: "Sara" } })).data).toMatchObject({ status: "approved" });
    const scheduled = await call<{ status: string; scheduledAt: string; scheduledAtLocal: string }>(hermes, "schedule_post", { postId, nextFreeSlot: true });
    expect(scheduled.data).toMatchObject({ status: "scheduled", scheduledAtLocal: "2026-11-10T17:00:00+05:00" });

    // the exact-time trigger fires at the slot
    env.clock.set(new Date(scheduled.data!.scheduledAt));
    expect((await publishPost(env.deps, postId)).result).toBe("published");

    const post = await call<{ status: string; permalink: string; events: { to: string | null; actor: string }[] }>(hermes, "get_post", { postId });
    expect(post.data!.status).toBe("published");
    expect(post.data!.permalink).toMatch(/instagram\.com/);
    expect(post.data!.events.filter((e) => e.to).map((e) => `${e.to} by ${e.actor}`)).toEqual([
      "draft by hermes",
      "awaiting_approval by hermes",
      "approved by Sara via inqi",
      "scheduled by hermes",
      "publishing by publisher",
      "published by publisher",
    ]);
  });

  it("enforces scopes with a message naming the missing scope", async () => {
    const inqi = await connect(keys.inqi);
    const r = await call(inqi, "create_post", { brand: "uppal-nq1", type: "image" });
    expect(r.error).toMatchObject({ code: "forbidden", message: expect.stringContaining("posts:write") });
    expect((await call(inqi, "update_brand_guidelines", { brand: "uppal-nq1", guidelines: { voice: "x" } })).error?.code).toBe("forbidden");
  });

  it("hides brands outside the key's allow-list", async () => {
    const inqi = await connect(keys.inqi);
    expect(((await call<{ slug: string }[]>(inqi, "list_brands")).data ?? []).map((b) => b.slug)).toEqual(["uppal-nq1"]);
    expect((await call(inqi, "get_brand", { brand: "other-client" })).error?.code).toBe("not_found");
  });

  it("returns field-level validation errors an agent can act on", async () => {
    const hermes = await connect(keys.hermes);
    const r = await call(hermes, "create_post", { brand: "uppal-nq1", type: "story", caption: "x".repeat(2300) });
    expect(r.error?.code).toBe("validation_error");
    expect(r.error?.details?.map((d) => d.field).sort()).toEqual(["caption", "type"]);

    const s = await call(hermes, "schedule_post", { postId: "6f1c2f0e-8a8b-4b55-9a39-6c0f6f1e2a10", scheduledAt: "tomorrow 5pm" });
    expect(s.error?.details?.[0]).toMatchObject({ field: "scheduledAt", message: expect.stringContaining("ISO-8601") });

    const unknown = await call(hermes, "make_coffee");
    expect(unknown.error).toMatchObject({ code: "not_found", hint: expect.stringContaining("tools/list") });
  });

  it("reports stale versions as version_conflict with a hint", async () => {
    const hermes = await connect(keys.hermes);
    const p = await call<{ id: string; version: number }>(hermes, "create_post", { brand: "uppal-nq1", type: "image" });
    await call(hermes, "update_post", { postId: p.data!.id, version: p.data!.version, caption: "first" });
    const stale = await call(hermes, "update_post", { postId: p.data!.id, version: p.data!.version, caption: "second" });
    expect(stale.error).toMatchObject({ code: "version_conflict", hint: expect.stringContaining("get_post") });
  });

  it("bulk_create_posts is atomic; get_calendar and get_free_slots work by slug", async () => {
    const hermes = await connect(keys.hermes);
    const bad = await call(hermes, "bulk_create_posts", { posts: [{ brand: "uppal-nq1", type: "image" }, { brand: "uppal-nq1", type: "gif" }] });
    expect(bad.error?.code).toBe("validation_error");
    expect((await call<{ posts: unknown[] }>(hermes, "list_posts", { brand: "uppal-nq1" })).data!.posts).toHaveLength(0);

    const ok = await call<{ created: unknown[] }>(hermes, "bulk_create_posts", {
      posts: [1, 2, 3].map((n) => ({ brand: "uppal-nq1", type: "image", caption: `Plan ${n}`, scheduledAt: `2026-11-1${n}T17:00:00+05:00` })),
    });
    expect(ok.data!.created).toHaveLength(3);
    const cal = await call<{ days: Record<string, unknown[]> }>(hermes, "get_calendar", { brand: "uppal-nq1", from: "2026-11-01T00:00:00+05:00", to: "2026-12-01T00:00:00+05:00" });
    expect(Object.keys(cal.data!.days)).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
    const slots = await call<{ slots: { local: string }[] }>(hermes, "get_free_slots", { brand: "uppal-nq1", limit: 2 });
    expect(slots.data!.slots.map((s) => s.local)).toEqual(["2026-11-10T17:00:00+05:00", "2026-11-14T17:00:00+05:00"]);
  });

  it("insights tools answer before any metrics exist", async () => {
    const inqi = await connect(keys.inqi);
    const r = await call<{ publishedPosts: number; totals: { reach: number } }>(inqi, "get_brand_insights", { brand: "uppal-nq1" });
    expect(r.data).toMatchObject({ publishedPosts: 0, totals: { reach: 0 } });
  });

  it("serves brand guidelines and month calendars as resources", async () => {
    const inqi = await connect(keys.inqi);
    const { resources } = await inqi.listResources();
    expect(resources.map((r) => r.uri)).toEqual(["brand://uppal-nq1/guidelines", "brand://uppal-nq1/calendar/2026-11"]);
    const { resourceTemplates } = await inqi.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(["brand://{slug}/guidelines", "brand://{slug}/calendar/{yyyy-mm}"]);

    const g = JSON.parse(((await inqi.readResource({ uri: "brand://uppal-nq1/guidelines" })).contents[0] as { text: string }).text);
    expect(g.guidelines.voice).toBe("Calm, honest, no hype");
    expect(g.postingSlots).toHaveLength(7);
    const cal = JSON.parse(((await inqi.readResource({ uri: "brand://uppal-nq1/calendar/2026-11" })).contents[0] as { text: string }).text);
    expect(cal).toMatchObject({ brand: { slug: "uppal-nq1", timezone: "Asia/Karachi" }, days: {} });

    await expect(inqi.readResource({ uri: "brand://other-client/guidelines" })).rejects.toThrow(/not found/i);
    await expect(inqi.readResource({ uri: "brand://uppal-nq1/whatever" })).rejects.toThrow(/Unknown resource URI/);
  });

  it("rejects missing and wrong API keys with 401", async () => {
    const res = await mcpFetch(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    await expect(connect(keys.hermes.slice(0, -3) + "abc")).rejects.toThrow();
  });

  it("REST mirror: same tools, keys, scopes and error shape", async () => {
    const rest = (key: string | null, name: string, body: unknown) =>
      restCallTool(new Request(`http://planner.test/api/v1/tools/${name}`, { method: "POST", headers: key ? { Authorization: `Bearer ${key}` } : {}, body: JSON.stringify(body) }), env.deps, name);

    const ok = await rest(keys.inqi, "get_brand", { brand: "uppal-nq1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ slug: "uppal-nq1" });

    const denied = await rest(keys.inqi, "create_post", { brand: "uppal-nq1", type: "image" });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("forbidden");

    expect((await rest(null, "get_brand", { brand: "uppal-nq1" })).status).toBe(401);
  });
});
