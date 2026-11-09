import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { accounts, users } from "@/lib/db/schema";
import { createAuth } from "@/lib/auth/auth";
import { acceptInvite, createInvite, findInvite, listTeam, loadUserActor, revokeInvite, updateMember } from "@/lib/services/users";
import { listPosts, createPost } from "@/lib/services/posts";
import { makeBrand, makeUser, setupEnv, type TestEnv } from "./helpers";

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: async (m: { to: string; subject: string; text: string }) => {
    sent.push(m);
  },
}));

const APP = "http://localhost:3000";
const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)![0];
const tokenOf = (url: string) => url.split("/invite/")[1];

describe("auth: invites, sign-in, roles", () => {
  let env: TestEnv;
  let auth: ReturnType<typeof createAuth>;
  beforeEach(async () => {
    env = await setupEnv();
    auth = createAuth(env.db, { baseURL: APP, secret: "test-secret-0123456789abcdef0123456789", nextjs: false });
    sent.length = 0;
  });
  afterEach(async () => env.close());

  async function signIn(email: string, password: string) {
    const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }

  it("owner invites a client; the client sets a password and signs in with only their brand", async () => {
    const brand = await makeBrand(env);
    await makeBrand(env, { slug: "other", name: "Other" });
    const owner = await makeUser(env, "owner");
    const { url, emailed } = await createInvite(env.ctx(owner), { email: "Client@Example.test", role: "client", brandIds: [brand.id] }, APP);
    expect(emailed).toBe(true);
    expect(sent[0]).toMatchObject({ to: "client@example.test", subject: "You're invited to Social Planner" });
    expect(linkIn(sent[0].text)).toBe(url);

    expect(await findInvite(env.db, tokenOf(url))).toMatchObject({ email: "client@example.test", role: "client" });
    const { userId } = await acceptInvite(env.db, { token: tokenOf(url), name: "Sara", password: "correct horse battery" });
    await expect(acceptInvite(env.db, { token: tokenOf(url), name: "Again", password: "correct horse battery" })).rejects.toMatchObject({ code: "not_found" });

    const { status, cookie } = await signIn("client@example.test", "correct horse battery");
    expect(status).toBe(200);
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user).toMatchObject({ id: userId, email: "client@example.test", role: "client" });

    const actor = await loadUserActor(env.db, userId);
    expect(actor).toMatchObject({ role: "client", brandIds: [brand.id] });
    expect((await signIn("client@example.test", "wrong password!!")).status).toBe(401);
  });

  it("closes open sign-up", async () => {
    await expect(auth.api.signUpEmail({ body: { email: "x@example.test", password: "long enough password", name: "X" } })).rejects.toThrow();
  });

  it("disabled users can't sign in and lose their sessions", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const { url } = await createInvite(env.ctx(owner), { email: "m@example.test", role: "manager", brandIds: [brand.id] }, APP);
    const { userId } = await acceptInvite(env.db, { token: tokenOf(url), name: "M", password: "manager password 1" });
    const before = await signIn("m@example.test", "manager password 1");
    expect(before.status).toBe(200);

    await updateMember(env.ctx(owner), { userId, disabled: true });
    expect(await auth.api.getSession({ headers: new Headers({ cookie: before.cookie }) })).toBeNull();
    expect((await signIn("m@example.test", "manager password 1")).status).toBe(403);
    expect(await loadUserActor(env.db, userId)).toBeNull();
  });

  it("an owner seeded without a password can set one through reset", async () => {
    const id = randomUUID();
    await env.db.insert(users).values({ id, name: "Ali", email: "owner@example.test", role: "owner", emailVerified: true });
    await auth.api.requestPasswordReset({ body: { email: "owner@example.test", redirectTo: `${APP}/reset-password` } });
    const resetUrl = linkIn(sent.at(-1)!.text);
    const token = new URL(resetUrl).pathname.split("/").pop()!;
    await auth.api.resetPassword({ body: { newPassword: "a brand new password", token } });
    expect(await env.db.select().from(accounts).where(eq(accounts.userId, id))).toHaveLength(1);
    expect((await signIn("owner@example.test", "a brand new password")).status).toBe(200);
  });

  it("magic links work for existing users", async () => {
    const owner = await makeUser(env, "owner");
    const [row] = await env.db.select().from(users).where(eq(users.id, owner.userId));
    await auth.api.signInMagicLink({ body: { email: row.email, callbackURL: "/dashboard" }, headers: new Headers() });
    const link = sent.find((m) => m.to === row.email);
    expect(link?.subject).toBe("Your Social Planner sign-in link");
    const token = new URL(linkIn(link!.text)).searchParams.get("token")!;
    const res = await auth.api.magicLinkVerify({ query: { token, callbackURL: "/dashboard" }, headers: new Headers(), asResponse: true });
    expect(res.headers.get("set-cookie")).toContain("session_token");
  });

  it("only owners invite; managers and clients need a brand; existing emails conflict", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const manager = await makeUser(env, "manager", [brand.id]);
    await expect(createInvite(env.ctx(manager), { email: "a@example.test", role: "client", brandIds: [brand.id] }, APP)).rejects.toMatchObject({ code: "forbidden" });
    await expect(createInvite(env.ctx(owner), { email: "a@example.test", role: "client" }, APP)).rejects.toMatchObject({ code: "validation_error" });
    const [m] = await env.db.select().from(users).where(eq(users.id, manager.userId));
    await expect(createInvite(env.ctx(owner), { email: m.email, role: "client", brandIds: [brand.id] }, APP)).rejects.toMatchObject({ code: "conflict" });
  });

  it("re-inviting replaces the old link; revoked and expired links stop working", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const first = await createInvite(env.ctx(owner), { email: "c@example.test", role: "client", brandIds: [brand.id] }, APP);
    const second = await createInvite(env.ctx(owner), { email: "c@example.test", role: "client", brandIds: [brand.id] }, APP);
    await expect(findInvite(env.db, tokenOf(first.url))).rejects.toMatchObject({ code: "not_found" });
    await expect(findInvite(env.db, tokenOf(second.url), new Date(env.clock.now().getTime() + 8 * 86_400_000))).rejects.toMatchObject({ code: "not_found" });
    expect((await listTeam(env.ctx(owner))).invites).toHaveLength(1);
    await revokeInvite(env.ctx(owner), second.invite.id);
    await expect(findInvite(env.db, tokenOf(second.url))).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps at least one active owner and stops owners locking themselves out", async () => {
    const owner = await makeUser(env, "owner");
    await expect(updateMember(env.ctx(owner), { userId: owner.userId, role: "manager" })).rejects.toMatchObject({ code: "validation_error" });
    const other = await makeUser(env, "owner");
    await updateMember(env.ctx(other), { userId: owner.userId, role: "manager" });
    await expect(updateMember(env.ctx(other), { userId: other.userId, disabled: true })).rejects.toMatchObject({ code: "validation_error" });
  });

  it("changing a member's brands changes what they can see", async () => {
    const a = await makeBrand(env, { slug: "brand-a", name: "A" });
    const b = await makeBrand(env, { slug: "brand-b", name: "B" });
    const owner = await makeUser(env, "owner");
    const client = await makeUser(env, "client", [a.id]);
    await createPost(env.ctx(owner), { brandId: b.id, type: "image", caption: "in B" });
    expect((await listPosts(env.ctx((await loadUserActor(env.db, client.userId))!), {})).posts).toHaveLength(0);
    await updateMember(env.ctx(owner), { userId: client.userId, brandIds: [b.id] });
    const moved = (await loadUserActor(env.db, client.userId))!;
    expect(moved.brandIds).toEqual([b.id]);
    expect((await listPosts(env.ctx(moved), {})).posts.map((p) => p.caption)).toEqual(["in B"]);
  });

  it("links an inqi user id to a planner user", async () => {
    const owner = await makeUser(env, "owner");
    const client = await makeUser(env, "client");
    await updateMember(env.ctx(owner), { userId: client.userId, externalUserId: "inqi-42" });
    await expect(updateMember(env.ctx(owner), { userId: owner.userId, externalUserId: "inqi-42" })).rejects.toMatchObject({ code: "conflict" });
  });
});
