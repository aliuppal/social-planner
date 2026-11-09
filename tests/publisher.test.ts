import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { posts, webhookDeliveries, webhooks } from "@/lib/db/schema";
import { encryptSecret } from "@/lib/crypto";
import { InstagramApiError } from "@/lib/instagram/client";
import type { Actor } from "@/lib/auth/guard";
import { approvePost, createPost, getPost, publishNow, retryFailedPost, schedulePost, submitForApproval } from "@/lib/services/posts";
import { publishPost, runDuePublishes } from "@/lib/services/publisher";
import { IMG, IMG2, VIDEO, makeApiClients, makeBrand, makeUser, setupEnv, type TestEnv } from "./helpers";

const MIN = 60_000;

describe("publisher", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setupEnv();
  });
  afterEach(async () => env.close());

  async function scheduledPost(actor: Actor, over: Partial<Parameters<typeof createPost>[1]> = {}) {
    const brand = await makeBrand(env, { slug: `b-${Math.random().toString(36).slice(2, 8)}`, requiresApproval: false });
    const p = await createPost(env.ctx(actor), { brandId: brand.id, type: "image", caption: "NQ1: patience pays", hashtags: ["nq1", "futures"], media: [{ url: IMG }], ...over });
    const s = await schedulePost(env.ctx(actor), { postId: p.id, nextFreeSlot: true });
    return { brand, post: s };
  }
  const row = async (id: string) => (await env.db.select().from(posts).where(eq(posts.id, id)))[0];
  const toSlot = (iso: string) => env.clock.set(new Date(iso));

  it("acceptance: hermes creates, inqi approves, next free slot, publishes with permalink and full audit trail", async () => {
    const brand = await makeBrand(env);
    const { hermes, inqi } = await makeApiClients(env, brand.id);
    const p = await createPost(env.ctx(hermes), { brandId: brand.id, type: "image", caption: "Today's NQ1 trade: waited for the retest.", media: [{ url: IMG, altText: "NQ1 5-minute chart" }] });
    await submitForApproval(env.ctx(hermes), { postId: p.id });
    await approvePost(env.ctx(inqi), { postId: p.id, actingUser: { id: "c-1", name: "Client" } });
    const s = await schedulePost(env.ctx(hermes), { postId: p.id, nextFreeSlot: true });
    expect(s.scheduledAtLocal).toBe("2026-11-10T17:00:00+05:00");

    // the exact-time trigger exists; firing it early does nothing
    expect(env.queue.pendingFor(p.id)).toHaveLength(1);
    expect((await publishPost(env.deps, p.id)).result).toBe("skipped");

    toSlot(s.scheduledAt!);
    const out = await publishPost(env.deps, p.id);
    expect(out.result).toBe("published");

    const full = await getPost(env.ctx(hermes), p.id);
    expect(full.status).toBe("published");
    expect(full.permalink).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
    expect(full.publishedAt).toBe(s.scheduledAt);
    expect(full.events.filter((e) => e.kind === "transition").map((e) => `${e.from ?? "∅"}→${e.to} by ${e.actor}`)).toEqual([
      "∅→draft by hermes",
      "draft→awaiting_approval by hermes",
      "awaiting_approval→approved by Client via inqi",
      "approved→scheduled by hermes",
      "scheduled→publishing by publisher",
      "publishing→published by publisher",
    ]);
    // a second trigger (e.g. the sweep) never re-posts
    expect((await runDuePublishes(env.deps)).length).toBe(0);
    expect(env.ig.count("publishContainer")).toBe(1);
  });

  it("sends caption + hashtags and the AI flag to Instagram, then posts the first comment", async () => {
    const owner = await makeUser(env, "owner");
    const { post } = await scheduledPost(owner, { firstComment: "Full breakdown in stories", isAiGenerated: true });
    toSlot(post.scheduledAt!);
    await publishPost(env.deps, post.id);
    const create = env.ig.calls.find((c) => c.method === "createContainer")!.args[0];
    expect(create).toMatchObject({ kind: "image", caption: "NQ1: patience pays\n\n#nq1 #futures", isAiGenerated: true });
    expect(env.ig.comments).toEqual([{ mediaId: (await row(post.id)).igMediaId, message: "Full breakdown in stories" }]);
  });

  it("idempotency: an error between container creation and publish reuses the same container on retry", async () => {
    const owner = await makeUser(env, "owner");
    const { post } = await scheduledPost(owner);
    toSlot(post.scheduledAt!);
    env.ig.failNext("publishContainer", new InstagramApiError("timeout", { transient: true }));

    const first = await publishPost(env.deps, post.id);
    expect(first.result).toBe("retry");
    const mid = await row(post.id);
    expect(mid.status).toBe("publishing");
    expect(mid.igContainerId).toBeTruthy();
    expect(mid.publishAttempts).toBe(1);

    env.clock.advance(1 * MIN); // first backoff
    const second = await publishPost(env.deps, post.id);
    expect(second.result).toBe("published");
    expect(env.ig.count("createContainer")).toBe(1);
    expect(env.ig.count("publishContainer")).toBe(2); // 1 failed + 1 succeeded
    expect(env.ig.media.size).toBe(1);
  });

  it("idempotency: a worker that crashes after creating the container is recovered by the sweep without a new container", async () => {
    const owner = await makeUser(env, "owner");
    const { post } = await scheduledPost(owner);
    toSlot(post.scheduledAt!);
    // simulate a worker that claimed the post, created the container, persisted its id, then died
    const { id: containerId } = await env.ig.createContainer({ igUserId: "x", accessToken: "x" }, { kind: "image", imageUrl: IMG, caption: "NQ1: patience pays\n\n#nq1 #futures" });
    await env.db.update(posts).set({ status: "publishing", igContainerId: containerId, nextAttemptAt: new Date(env.clock.now().getTime() + 5 * MIN) }).where(eq(posts.id, post.id));

    expect(await runDuePublishes(env.deps)).toEqual([]); // lease still held
    env.clock.advance(5 * MIN); // lease expires
    const [out] = await runDuePublishes(env.deps);
    expect(out.result).toBe("published");
    expect(env.ig.count("createContainer")).toBe(1);
    expect(env.ig.count("publishContainer")).toBe(1);
    expect((await row(post.id)).igContainerId).toBe(containerId);
  });

  it("idempotency: if Instagram published but the response was lost, the retry finds the post instead of re-posting", async () => {
    const owner = await makeUser(env, "owner");
    const { post } = await scheduledPost(owner);
    toSlot(post.scheduledAt!);
    env.ig.loseResponseNext("publishContainer");

    expect((await publishPost(env.deps, post.id)).result).toBe("retry");
    expect(env.ig.media.size).toBe(1); // it IS live on Instagram

    env.clock.advance(1 * MIN);
    expect((await publishPost(env.deps, post.id)).result).toBe("published");
    expect(env.ig.count("publishContainer")).toBe(1);
    expect(env.ig.media.size).toBe(1);
    const r = await row(post.id);
    expect(r.igMediaId).toBe([...env.ig.media.keys()][0]);
    expect(r.permalink).toBeTruthy();
  });

  it("retries with backoff, then fails and writes the post.failed webhook to the outbox", async () => {
    const owner = await makeUser(env, "owner");
    const { brand, post } = await scheduledPost(owner);
    const { hermes } = await makeApiClients(env, brand.id);
    await env.db.insert(webhooks).values({ apiClientId: hermes.clientId, url: "https://hermes.example.test/hook", events: ["post.failed", "post.published"], secretEnc: encryptSecret("whsec") });
    toSlot(post.scheduledAt!);
    for (let i = 0; i < 3; i++) env.ig.failNext("createContainer", new InstagramApiError("Service unavailable", { transient: true, status: 503 }));

    expect((await publishPost(env.deps, post.id)).retryAt).toBe(new Date(env.clock.now().getTime() + 1 * MIN).toISOString());
    env.clock.advance(1 * MIN);
    expect((await publishPost(env.deps, post.id)).retryAt).toBe(new Date(env.clock.now().getTime() + 5 * MIN).toISOString());
    env.clock.advance(5 * MIN);
    const last = await publishPost(env.deps, post.id);
    expect(last.result).toBe("failed");

    const r = await row(post.id);
    expect(r).toMatchObject({ status: "failed", publishAttempts: 3, lastError: "Service unavailable" });
    const deliveries = await env.db.select().from(webhookDeliveries);
    expect(deliveries.map((d) => d.event)).toEqual(["post.failed"]);
    expect(deliveries[0].payload).toMatchObject({ event: "post.failed", data: { postId: post.id, to: "failed", error: "Service unavailable" } });
  });

  it("fails immediately on a non-transient error and can be retried, reusing the container", async () => {
    const owner = await makeUser(env, "owner");
    const { post } = await scheduledPost(owner);
    toSlot(post.scheduledAt!);
    env.ig.failNext("publishContainer", new InstagramApiError("Media is not ready / invalid", { transient: false, code: 9007 }));
    expect((await publishPost(env.deps, post.id)).result).toBe("failed");

    await retryFailedPost(env.ctx(owner), { postId: post.id });
    expect((await publishPost(env.deps, post.id)).result).toBe("published");
    expect(env.ig.count("createContainer")).toBe(1);
  });

  it("reels: polls the container once a minute until it's ready", async () => {
    const owner = await makeUser(env, "owner");
    env.ig.videoPollsUntilReady = 2;
    const brand = await makeBrand(env, { slug: "reels", requiresApproval: false });
    const p = await createPost(env.ctx(owner), { brandId: brand.id, type: "reel", caption: "Morning routine", media: [{ url: VIDEO }] });
    const s = await schedulePost(env.ctx(owner), { postId: p.id, nextFreeSlot: true });
    toSlot(s.scheduledAt!);

    const first = await publishPost(env.deps, p.id);
    expect(first).toMatchObject({ result: "pending" });
    expect(env.queue.pendingFor(p.id).some(([, j]) => j.at.getTime() === env.clock.now().getTime() + MIN)).toBe(true);
    expect((await publishPost(env.deps, p.id)).result).toBe("skipped"); // not yet a minute

    env.clock.advance(MIN);
    expect((await publishPost(env.deps, p.id)).result).toBe("published");
    expect(env.ig.count("createContainer")).toBe(1);
  });

  it("carousels: creates children then the parent, in media order", async () => {
    const owner = await makeUser(env, "owner");
    const { post } = await scheduledPost(owner, { type: "carousel", media: [{ url: IMG }, { url: IMG2 }] });
    toSlot(post.scheduledAt!);
    expect((await publishPost(env.deps, post.id)).result).toBe("published");
    const created = env.ig.calls.filter((c) => c.method === "createContainer").map((c) => c.args[0] as { kind: string; imageUrl?: string });
    expect(created.map((c) => c.kind)).toEqual(["carousel_item", "carousel_item", "carousel"]);
    expect(created[0].imageUrl).toBe(IMG);
  });

  it("publish_now uses the same worker path and cancels the timed trigger", async () => {
    const owner = await makeUser(env, "owner");
    const { post } = await scheduledPost(owner);
    expect(env.queue.pendingFor(post.id)).toHaveLength(1);
    const r = await publishNow(env.ctx(owner), { postId: post.id });
    expect(r.outcome.result).toBe("published");
    expect(r.post.status).toBe("published");
    expect(env.queue.pendingFor(post.id)).toHaveLength(0);
  });

  it("waits and retries when the publishing quota is used up, without counting a failed attempt", async () => {
    const owner = await makeUser(env, "owner");
    const { post } = await scheduledPost(owner);
    toSlot(post.scheduledAt!);
    env.ig.publishLimit = { used: 100, total: 100 };
    const out = await publishPost(env.deps, post.id);
    expect(out.result).toBe("retry");
    expect((await row(post.id)).publishAttempts).toBe(0);
  });
});
