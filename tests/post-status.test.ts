import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST_STATUSES } from "@/lib/schemas/post";
import { TRANSITIONS, checkTransition } from "@/lib/services/post-status";
import { approvePost, cancelPost, createPost, getPost, rejectPost, schedulePost, submitForApproval, updatePost } from "@/lib/services/posts";
import { IMG, makeApiClients, makeBrand, makeUser, setupEnv, type TestEnv } from "./helpers";

const user = { requiresApproval: true, actorKind: "user" as const };

describe("transition table (pure)", () => {
  it("allows exactly the documented happy path", () => {
    const path = ["idea", "draft", "awaiting_approval", "approved", "scheduled"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(checkTransition(path[i], path[i + 1], user).ok).toBe(true);
    expect(checkTransition("scheduled", "publishing", { ...user, actorKind: "system" }).ok).toBe(true);
    expect(checkTransition("publishing", "published", { ...user, actorKind: "system" }).ok).toBe(true);
  });

  it("supports reject → draft and failed → scheduled", () => {
    expect(checkTransition("awaiting_approval", "rejected", user).ok).toBe(true);
    expect(checkTransition("rejected", "draft", user).ok).toBe(true);
    expect(checkTransition("failed", "scheduled", user).ok).toBe(true);
  });

  it("lets any non-published state be cancelled, except while publishing", () => {
    for (const s of POST_STATUSES) {
      const ok = checkTransition(s, "cancelled", user).ok;
      expect(ok, s).toBe(!["published", "publishing", "cancelled"].includes(s));
    }
  });

  it("treats published and cancelled as final", () => {
    expect(TRANSITIONS.published).toEqual([]);
    expect(TRANSITIONS.cancelled).toEqual([]);
  });

  it("only allows draft → approved when the brand doesn't require approval", () => {
    expect(checkTransition("draft", "approved", user).ok).toBe(false);
    expect(checkTransition("draft", "approved", { ...user, requiresApproval: false }).ok).toBe(true);
  });

  it("reserves publishing/published/failed for the publisher", () => {
    for (const to of ["publishing", "published", "failed"] as const) {
      const from = to === "publishing" ? "scheduled" : "publishing";
      expect(checkTransition(from, to, user).ok).toBe(false);
      expect(checkTransition(from, to, { ...user, actorKind: "api_client" }).ok).toBe(false);
      expect(checkTransition(from, to, { ...user, actorKind: "system" }).ok).toBe(true);
    }
  });

  it("explains what is allowed when a transition is rejected", () => {
    const r = checkTransition("idea", "scheduled", user);
    expect(r).toMatchObject({ ok: false, message: "Can't move a post from 'idea' to 'scheduled'." });
    if (!r.ok) expect(r.hint).toContain("draft, cancelled");
  });
});

describe("transitions against the database", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setupEnv();
  });
  afterEach(async () => env.close());

  it("writes an audit event for every step, with actor and acting user", async () => {
    const brand = await makeBrand(env);
    const { hermes, inqi } = await makeApiClients(env, brand.id);
    const post = await createPost(env.ctx(hermes), { brandId: brand.id, type: "image", caption: "NQ1 long at VWAP", media: [{ url: IMG }] });
    expect(post.source).toBe("hermes");
    await submitForApproval(env.ctx(hermes), { postId: post.id });
    await approvePost(env.ctx(inqi), { postId: post.id, comment: "Looks good", actingUser: { id: "inqi-user-42", name: "Sara (client)" } });

    const full = await getPost(env.ctx(hermes), post.id);
    expect(full.status).toBe("approved");
    expect(full.events.map((e) => [e.from, e.to, e.actor])).toEqual([
      [null, "draft", "hermes"],
      ["draft", "awaiting_approval", "hermes"],
      ["awaiting_approval", "approved", "Sara (client) via inqi"],
    ]);
    expect(full.events[2]).toMatchObject({ actorType: "api_client", comment: "Looks good", actingUser: { id: "inqi-user-42", name: "Sara (client)" } });
  });

  it("rejects invalid transitions with a clear error", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const post = await createPost(env.ctx(owner), { brandId: brand.id, type: "image", media: [{ url: IMG }] });
    await expect(approvePost(env.ctx(owner), { postId: post.id })).rejects.toMatchObject({ code: "invalid_transition", opts: { hint: "Call submit_for_approval first." } });
    await expect(schedulePost(env.ctx(owner), { postId: post.id, nextFreeSlot: true })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("reject requires a comment and returns the post to draft on resubmit", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const post = await createPost(env.ctx(owner), { brandId: brand.id, type: "image", media: [{ url: IMG }] });
    await submitForApproval(env.ctx(owner), { postId: post.id });
    await expect(rejectPost(env.ctx(owner), { postId: post.id })).rejects.toMatchObject({ code: "validation_error" });
    await rejectPost(env.ctx(owner), { postId: post.id, comment: "Text too small" });
    const again = await submitForApproval(env.ctx(owner), { postId: post.id });
    expect(again.status).toBe("awaiting_approval");
    const events = (await getPost(env.ctx(owner), post.id)).events.map((e) => e.to);
    expect(events).toEqual(["draft", "awaiting_approval", "rejected", "draft", "awaiting_approval"]);
  });

  it("allows draft → scheduled directly when the brand doesn't require approval", async () => {
    const brand = await makeBrand(env, { slug: "no-approval", requiresApproval: false });
    const owner = await makeUser(env, "owner");
    const post = await createPost(env.ctx(owner), { brandId: brand.id, type: "image", media: [{ url: IMG }] });
    const scheduled = await schedulePost(env.ctx(owner), { postId: post.id, nextFreeSlot: true });
    expect(scheduled.status).toBe("scheduled");
    const events = (await getPost(env.ctx(owner), post.id)).events.map((e) => e.to);
    expect(events).toEqual(["draft", "approved", "scheduled"]);
  });

  it("editing the caption of a scheduled post sends it back for approval and cancels its trigger", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const post = await createPost(env.ctx(owner), { brandId: brand.id, type: "image", caption: "v1", media: [{ url: IMG }] });
    await submitForApproval(env.ctx(owner), { postId: post.id });
    await approvePost(env.ctx(owner), { postId: post.id });
    const s = await schedulePost(env.ctx(owner), { postId: post.id, nextFreeSlot: true });
    expect(env.queue.pendingFor(post.id)).toHaveLength(1);

    const edited = await updatePost(env.ctx(owner), { postId: post.id, version: s.version, caption: "v2" });
    expect(edited.status).toBe("awaiting_approval");
    expect(env.queue.pendingFor(post.id)).toHaveLength(0);
    expect(env.queue.cancelled).toHaveLength(1);
  });

  it("editing notes only keeps the post approved", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const post = await createPost(env.ctx(owner), { brandId: brand.id, type: "image", media: [{ url: IMG }] });
    await submitForApproval(env.ctx(owner), { postId: post.id });
    const a = await approvePost(env.ctx(owner), { postId: post.id });
    const edited = await updatePost(env.ctx(owner), { postId: post.id, version: a.version, notes: "internal note" });
    expect(edited.status).toBe("approved");
  });

  it("returns a version conflict for stale updates", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const post = await createPost(env.ctx(owner), { brandId: brand.id, type: "image", media: [{ url: IMG }] });
    await updatePost(env.ctx(owner), { postId: post.id, version: post.version, caption: "first" });
    await expect(updatePost(env.ctx(owner), { postId: post.id, version: post.version, caption: "second" })).rejects.toMatchObject({
      code: "version_conflict",
      opts: { data: { currentVersion: post.version + 1 } },
    });
  });

  it("cancelling a scheduled post cancels its trigger", async () => {
    const brand = await makeBrand(env, { slug: "quick", requiresApproval: false });
    const owner = await makeUser(env, "owner");
    const post = await createPost(env.ctx(owner), { brandId: brand.id, type: "image", media: [{ url: IMG }] });
    await schedulePost(env.ctx(owner), { postId: post.id, nextFreeSlot: true });
    const c = await cancelPost(env.ctx(owner), { postId: post.id, comment: "not needed" });
    expect(c.status).toBe("cancelled");
    expect(env.queue.pendingFor(post.id)).toHaveLength(0);
  });
});
