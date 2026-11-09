import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@/lib/db";
import { accounts, brandMembers, brands, invites, sessions, users, type UserRole } from "@/lib/db/schema";
import { assertCan, type UserActor } from "@/lib/auth/guard";
import { randomToken, sha256 } from "@/lib/crypto";
import { actionEmail, sendEmail } from "@/lib/email";
import { AppError, notFound, parse } from "@/lib/errors";
import { id } from "@/lib/schemas/post";
import { DAY } from "@/lib/time";
import type { Ctx } from "./context";

export const MIN_PASSWORD = 10;
const INVITE_TTL_MS = 7 * DAY;
const ROLES = ["owner", "manager", "client"] as const;

// ---------- Session → actor ----------

/** Build the actor for a signed-in user. Disabled or missing users get null (treated as signed out). */
export async function loadUserActor(db: DbOrTx, userId: string): Promise<UserActor | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u || u.disabledAt) return null;
  if (u.role === "owner") return { kind: "user", userId: u.id, name: u.name, role: u.role, brandIds: "all" };
  const rows = await db.select({ brandId: brandMembers.brandId }).from(brandMembers).where(eq(brandMembers.userId, u.id));
  return { kind: "user", userId: u.id, name: u.name, role: u.role, brandIds: rows.map((r) => r.brandId) };
}

// ---------- Invites ----------

export const inviteSchema = z.object({
  email: z.email({ message: "a valid email address" }).transform((e) => e.trim().toLowerCase()),
  role: z.enum(ROLES),
  brandIds: z.array(id).default([]),
});

async function assertBrandsExist(db: DbOrTx, brandIds: string[]) {
  if (!brandIds.length) return;
  const found = await db.select({ id: brands.id }).from(brands).where(inArray(brands.id, brandIds));
  if (found.length !== new Set(brandIds).size) throw new AppError("validation_error", "One or more brands don't exist.", { details: [{ field: "brandIds", message: "unknown brand" }] });
}

/** Owner invites someone by email. Returns the link too, so it can be shared by hand when email isn't set up. */
export async function createInvite(ctx: Ctx, input: z.input<typeof inviteSchema>, appUrl: string) {
  assertCan(ctx.actor, "admin");
  const data = parse(inviteSchema, input);
  if (data.role !== "owner" && !data.brandIds.length) {
    throw new AppError("validation_error", "Pick at least one brand for a manager or client.", { details: [{ field: "brandIds", message: "required" }] });
  }
  const [existing] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, data.email));
  if (existing) throw new AppError("conflict", `${data.email} already has an account.`, { hint: "Change their role or brands in the team list instead." });
  await assertBrandsExist(ctx.db, data.brandIds);

  const token = randomToken(32);
  const now = ctx.now();
  const invite = await ctx.db.transaction(async (tx) => {
    // a new invite replaces any pending one for the same email
    await tx.delete(invites).where(and(eq(invites.email, data.email), isNull(invites.acceptedAt)));
    const [row] = await tx
      .insert(invites)
      .values({ email: data.email, role: data.role, brandIds: data.brandIds, tokenHash: sha256(token), invitedBy: ctx.actor.kind === "user" ? ctx.actor.userId : null, expiresAt: new Date(now.getTime() + INVITE_TTL_MS), createdAt: now })
      .returning();
    return row;
  });

  const url = `${appUrl.replace(/\/$/, "")}/invite/${token}`;
  let emailed = true;
  try {
    await sendEmail({
      to: data.email,
      subject: "You're invited to Social Planner",
      ...actionEmail({ heading: "You're invited", body: `You've been invited to Social Planner as ${data.role}. Set your password to get started. The link expires in 7 days.`, cta: "Accept invite", url }),
    });
  } catch (err) {
    emailed = false;
    ctx.log.warn({ inviteId: invite.id, err: err instanceof Error ? err.message : String(err) }, "invite email failed; share the link by hand");
  }
  return { invite: inviteView(invite), url, emailed };
}

const inviteView = (i: typeof invites.$inferSelect) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  brandIds: i.brandIds,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
});

export async function revokeInvite(ctx: Ctx, inviteId: string) {
  assertCan(ctx.actor, "admin");
  const [gone] = await ctx.db.delete(invites).where(and(eq(invites.id, parse(id, inviteId)), isNull(invites.acceptedAt))).returning();
  if (!gone) throw notFound("Invite", inviteId);
  return { ok: true };
}

/** Public: look up an invite by its link token (for the accept page). */
export async function findInvite(db: DbOrTx, token: string, now = new Date()) {
  const [i] = await db
    .select()
    .from(invites)
    .where(and(eq(invites.tokenHash, sha256(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, now)));
  if (!i) throw new AppError("not_found", "This invite link is invalid, already used or expired.", { hint: "Ask the person who invited you for a new link." });
  return inviteView(i);
}

export const acceptInviteSchema = z.object({
  token: z.string().min(20),
  name: z.string().trim().min(1, "Enter your name").max(120),
  password: z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters`).max(128),
});

/** Public: create the account from an invite and set its password. The caller then signs the user in. */
export async function acceptInvite(db: Db, input: z.input<typeof acceptInviteSchema>, now = new Date()) {
  const data = parse(acceptInviteSchema, input);
  const passwordHash = await hashPassword(data.password);
  return db.transaction(async (tx) => {
    const [i] = await tx
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, sha256(data.token)), isNull(invites.acceptedAt), gt(invites.expiresAt, now)))
      .for("update");
    if (!i) throw new AppError("not_found", "This invite link is invalid, already used or expired.", { hint: "Ask the person who invited you for a new link." });
    const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, i.email));
    if (taken) throw new AppError("conflict", "An account with this email already exists. Sign in instead.");

    const userId = randomUUID();
    await tx.insert(users).values({ id: userId, name: data.name, email: i.email, emailVerified: true, role: i.role, createdAt: now, updatedAt: now });
    if (i.brandIds.length) await tx.insert(brandMembers).values(i.brandIds.map((brandId) => ({ brandId, userId }))).onConflictDoNothing();
    await tx.insert(accounts).values({ id: randomUUID(), userId, accountId: userId, providerId: "credential", password: passwordHash, createdAt: now, updatedAt: now });
    await tx.update(invites).set({ acceptedAt: now }).where(eq(invites.id, i.id));
    return { userId, email: i.email, role: i.role };
  });
}

// ---------- Team management (owner) ----------

export async function listTeam(ctx: Ctx) {
  assertCan(ctx.actor, "admin");
  const [rows, members, pending] = await Promise.all([
    ctx.db.select().from(users).orderBy(asc(users.name)),
    ctx.db.select().from(brandMembers),
    ctx.db.select().from(invites).where(and(isNull(invites.acceptedAt), gt(invites.expiresAt, ctx.now()))).orderBy(asc(invites.createdAt)),
  ]);
  return {
    users: rows.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      externalUserId: u.externalUserId,
      disabled: Boolean(u.disabledAt),
      brandIds: u.role === "owner" ? ("all" as const) : members.filter((m) => m.userId === u.id).map((m) => m.brandId),
      createdAt: u.createdAt.toISOString(),
    })),
    invites: pending.map(inviteView),
  };
}

export const updateMemberSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(ROLES).optional(),
  brandIds: z.array(id).optional(),
  disabled: z.boolean().optional(),
  /** inqi's id for this person, so audit entries from inqi link to them */
  externalUserId: z.string().trim().max(200).nullish(),
});

export async function updateMember(ctx: Ctx, input: z.input<typeof updateMemberSchema>) {
  assertCan(ctx.actor, "admin");
  const data = parse(updateMemberSchema, input);
  const selfId = ctx.actor.kind === "user" ? ctx.actor.userId : null;

  return ctx.db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, data.userId)).for("update");
    if (!u) throw notFound("User", data.userId);

    if (data.userId === selfId && (data.disabled || (data.role && data.role !== "owner"))) {
      throw new AppError("validation_error", "You can't disable yourself or remove your own owner role.");
    }
    const losingOwner = u.role === "owner" && ((data.role && data.role !== "owner") || data.disabled);
    if (losingOwner) {
      const others = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, "owner"), isNull(users.disabledAt), ne(users.id, u.id)));
      if (!others.length) throw new AppError("validation_error", "There must always be at least one active owner.");
    }
    if (data.externalUserId) {
      const [clash] = await tx.select({ id: users.id }).from(users).where(and(eq(users.externalUserId, data.externalUserId), ne(users.id, u.id)));
      if (clash) throw new AppError("conflict", "That inqi user id is already linked to someone else.");
    }

    const patch: Partial<typeof users.$inferInsert> = { updatedAt: ctx.now() };
    if (data.role) patch.role = data.role as UserRole;
    if (data.disabled !== undefined) patch.disabledAt = data.disabled ? ctx.now() : null;
    if (data.externalUserId !== undefined) patch.externalUserId = data.externalUserId || null;
    await tx.update(users).set(patch).where(eq(users.id, u.id));

    if (data.brandIds) {
      await assertBrandsExist(tx, data.brandIds);
      await tx.delete(brandMembers).where(eq(brandMembers.userId, u.id));
      if (data.brandIds.length) await tx.insert(brandMembers).values(data.brandIds.map((brandId) => ({ brandId, userId: u.id })));
    }
    // disabling signs the person out everywhere
    if (data.disabled) await tx.delete(sessions).where(eq(sessions.userId, u.id));
    return { ok: true };
  });
}
