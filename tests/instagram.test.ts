import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instagramAccounts, posts } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { GraphInstagramClient, signState, verifyState } from "@/lib/instagram/graph";
import { InstagramApiError } from "@/lib/instagram/client";
import { isAuthorizedJob } from "@/lib/queue/qstash";
import { connectAccount, refreshTokens, syncBrand } from "@/lib/services/instagram";
import { createPost } from "@/lib/services/posts";
import { makeBrand, makeUser, setupEnv, type TestEnv } from "./helpers";

const DAY = 86_400_000;
const profile = (over: Partial<Parameters<typeof connectAccount>[2]> = {}) => ({ accessToken: "IGAA-secret-token", expiresIn: 60 * 86_400, igUserId: "1784", username: "uppal.nq1", accountType: "BUSINESS", scopes: ["instagram_business_basic"], ...over });

describe("OAuth state", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-state-secret";
  });
  it("round-trips, and rejects tampered or expired state", () => {
    const s = signState({ brandId: "b1", userId: "u1" }, 1_000);
    expect(verifyState(s, 2_000)).toEqual({ brandId: "b1", userId: "u1" });
    expect(verifyState(s.slice(0, -2) + "xx", 2_000)).toBeNull();
    expect(verifyState(s, 1_000 + 16 * 60_000)).toBeNull();
    expect(verifyState("garbage", 2_000)).toBeNull();
  });
});

describe("Instagram accounts and sync", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setupEnv();
  });
  afterEach(async () => env.close());

  it("stores the token encrypted and warns when the handle doesn't match the brand", async () => {
    const brand = await makeBrand(env, { instagramHandle: "@uppal.nq1" });
    const owner = await makeUser(env, "owner");
    expect((await connectAccount(env.ctx(owner), brand.id, profile())).warning).toBeUndefined();
    const [row] = await env.db.select().from(instagramAccounts).where(eq(instagramAccounts.brandId, brand.id));
    expect(row.accessTokenEnc).not.toContain("IGAA");
    expect(decryptSecret(row.accessTokenEnc)).toBe("IGAA-secret-token");
    expect(row.tokenExpiresAt!.getTime() - env.clock.now().getTime()).toBe(60 * DAY);

    const other = await makeBrand(env, { slug: "client-x", name: "Client X", instagramHandle: "@clientx" });
    await expect(connectAccount(env.ctx(owner), other.id, profile())).rejects.toMatchObject({ code: "conflict" });
    expect((await connectAccount(env.ctx(owner), other.id, profile({ igUserId: "99", username: "someone.else" }))).warning).toContain("@clientx");
  });

  it("only owners/managers with brand access can connect", async () => {
    const brand = await makeBrand(env);
    const client = await makeUser(env, "client", [brand.id]);
    await expect(connectAccount(env.ctx(client), brand.id, profile())).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refreshes tokens close to expiry, flags failures, and marks expired accounts", async () => {
    const owner = await makeUser(env, "owner");
    const a = await makeBrand(env, { slug: "brand-a" });
    const b = await makeBrand(env, { slug: "brand-b" });
    const c = await makeBrand(env, { slug: "brand-c" });
    await connectAccount(env.ctx(owner), a.id, profile({ igUserId: "1" }));
    await connectAccount(env.ctx(owner), b.id, profile({ igUserId: "2" }));
    await connectAccount(env.ctx(owner), c.id, profile({ igUserId: "3", expiresIn: 86_400 }));

    env.clock.advance(50 * DAY); // a and b: 10 days left; c: expired
    let calls = 0;
    const refresher = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new InstagramApiError("Invalid OAuth access token", { code: 190, transient: false });
      return { access_token: "IGAA-new", expires_in: 60 * 86_400 };
    });
    const results = await refreshTokens(env.deps, refresher);
    expect(results.map((r) => r.result).sort()).toEqual(["error", "expired", "refreshed"]);
    const rows = await env.db.select().from(instagramAccounts);
    expect(rows.map((r) => r.status).sort()).toEqual(["connected", "error", "expired"]);
  });

  it("imports posts made in the Instagram app, once, and links unconfirmed planner posts by caption", async () => {
    const owner = await makeUser(env, "owner");
    const brand = await makeBrand(env);
    await connectAccount(env.ctx(owner), brand.id, profile());

    // a planner post that published but whose media id was never confirmed
    const p = await createPost(env.ctx(owner), { brandId: brand.id, type: "image", caption: "Patience pays", hashtags: ["#NQ1"] });
    await env.db.update(posts).set({ status: "published", publishedAt: env.clock.now() }).where(eq(posts.id, p.id));

    env.ig.addExternalMedia({ caption: "Patience pays\n\n#NQ1" });
    const manual = env.ig.addExternalMedia({ caption: "Posted from my phone", mediaType: "CAROUSEL_ALBUM" });

    expect(await syncBrand(env.deps, brand.id)).toMatchObject({ imported: 1, linked: 1 });
    expect(await syncBrand(env.deps, brand.id)).toMatchObject({ imported: 0, linked: 0 });

    const all = await env.db.select().from(posts).where(eq(posts.brandId, brand.id));
    const imported = all.find((x) => x.igMediaId === manual.id)!;
    expect(imported).toMatchObject({ status: "published", source: "instagram", type: "carousel", caption: "Posted from my phone" });
    expect(all.find((x) => x.id === p.id)!.igMediaId).toBeTruthy();
  });
});

describe("job auth", () => {
  it("accepts CRON_SECRET or a QStash signature, nothing else", async () => {
    process.env.CRON_SECRET = "cron-secret";
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    const req = (h: Record<string, string>) => new Request("https://x/api/jobs/sweep", { method: "POST", headers: h });
    expect(await isAuthorizedJob(req({ authorization: "Bearer cron-secret" }), "")).toBe(true);
    expect(await isAuthorizedJob(req({ authorization: "Bearer nope" }), "")).toBe(false);
    expect(await isAuthorizedJob(req({ "upstash-signature": "forged" }), "")).toBe(false);
  });
});

describe("Graph API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the token in the POST body, never the URL", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "c1" }));
    vi.stubGlobal("fetch", fetchMock);
    await new GraphInstagramClient().createContainer({ igUserId: "1784", accessToken: "SECRET" }, { kind: "image", imageUrl: "https://x/a.jpg", caption: "hi" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/graph\.instagram\.com\/v\d+\.\d+\/1784\/media$/);
    expect(url).not.toContain("SECRET");
    expect(String(init.body)).toContain("access_token=SECRET");
    expect(String(init.body)).toContain("image_url=");
  });

  it("maps rate limits to transient errors and token errors to permanent ones", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Application request limit reached", code: 4 } }, { status: 400 })));
    await expect(new GraphInstagramClient().publishContainer({ igUserId: "1", accessToken: "t" }, "c")).rejects.toMatchObject({ transient: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Error validating access token", code: 190 } }, { status: 400 })));
    await expect(new GraphInstagramClient().publishContainer({ igUserId: "1", accessToken: "t" }, "c")).rejects.toMatchObject({ transient: false });
  });
});
