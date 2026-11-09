import { AppError } from "@/lib/errors";
import type { ActingUser, PostSource, UserRole } from "@/lib/db/schema";

export const SCOPES = [
  "posts:read",
  "posts:write",
  "posts:approve",
  "posts:publish",
  "brands:read",
  "brands:write",
  "insights:read",
] as const;
export type Scope = (typeof SCOPES)[number];

export type UserActor = {
  kind: "user";
  userId: string;
  name: string;
  role: UserRole;
  /** owner → "all"; others → brands they are a member of */
  brandIds: string[] | "all";
};
export type ApiClientActor = {
  kind: "api_client";
  clientId: string;
  name: string;
  source: PostSource;
  scopes: Scope[];
  brandIds: string[] | "all";
  /** inqi passes the client-portal user it acts for; recorded in the audit log */
  actingUser?: ActingUser;
};
export type SystemActor = { kind: "system"; name: string };
export type Actor = UserActor | ApiClientActor | SystemActor;

export const systemActor = (name = "system"): SystemActor => ({ kind: "system", name });

export type Action =
  | "post.read"
  | "post.create"
  | "post.edit"
  | "post.comment"
  | "post.submit"
  | "post.approve"
  | "post.schedule"
  | "post.publish"
  | "brand.read"
  | "brand.write"
  | "calendar.write"
  | "insights.read"
  | "admin";

/** API client: any one of these scopes grants the action. `admin` is never available to API keys. */
const ACTION_SCOPES: Record<Action, Scope[]> = {
  "post.read": ["posts:read"],
  "post.create": ["posts:write"],
  "post.edit": ["posts:write"],
  "post.comment": ["posts:write", "posts:approve"],
  "post.submit": ["posts:write"],
  "post.approve": ["posts:approve"],
  "post.schedule": ["posts:write"],
  "post.publish": ["posts:publish"],
  "brand.read": ["brands:read"],
  "brand.write": ["brands:write"],
  "calendar.write": ["posts:write"],
  "insights.read": ["insights:read"],
  admin: [],
};

const CLIENT_BASE: Action[] = ["post.read", "post.comment", "post.approve", "brand.read", "insights.read"];
const CLIENT_IF_SCHEDULING: Action[] = ["post.create", "post.edit", "post.submit", "post.schedule", "calendar.write"];

export type BrandRef = { id: string; clientsCanSchedule?: boolean };

export type Decision = { ok: true } | { ok: false; reason: string; hint?: string };

export function hasBrandAccess(actor: Actor, brandId: string): boolean {
  if (actor.kind === "system") return true;
  return actor.brandIds === "all" || actor.brandIds.includes(brandId);
}

export function can(actor: Actor, action: Action, brand?: BrandRef): Decision {
  if (actor.kind === "system") return { ok: true };

  if (brand && !hasBrandAccess(actor, brand.id)) {
    return { ok: false, reason: `No access to brand ${brand.id}`, hint: "Call list_brands to see the brands this key or user can access." };
  }

  if (actor.kind === "api_client") {
    const needed = ACTION_SCOPES[action];
    if (needed.length === 0) return { ok: false, reason: `${action} is not available to API clients` };
    if (!needed.some((s) => actor.scopes.includes(s))) {
      return { ok: false, reason: `API key "${actor.name}" lacks scope ${needed.join(" or ")} required for ${action}` };
    }
    return { ok: true };
  }

  // user
  switch (actor.role) {
    case "owner":
      return { ok: true };
    case "manager":
      return action === "admin" ? { ok: false, reason: "Only owners can manage users and API clients" } : { ok: true };
    case "client": {
      if (CLIENT_BASE.includes(action)) return { ok: true };
      if (CLIENT_IF_SCHEDULING.includes(action)) {
        if (brand?.clientsCanSchedule) return { ok: true };
        return { ok: false, reason: "This brand doesn't let clients create or schedule posts", hint: "An owner can enable 'clients can schedule' on the brand." };
      }
      return { ok: false, reason: `Clients can't ${action.replace(".", " ")}` };
    }
  }
}

export function assertCan(actor: Actor, action: Action, brand?: BrandRef): void {
  const d = can(actor, action, brand);
  if (!d.ok) throw new AppError("forbidden", d.reason, { hint: d.hint });
}

/** Brand ids to filter list queries by; "all" means no filter. */
export function brandScope(actor: Actor): string[] | "all" {
  return actor.kind === "system" ? "all" : actor.brandIds;
}

export function actorSource(actor: Actor): PostSource {
  if (actor.kind === "api_client") return actor.source;
  return "ui";
}

export function actorName(actor: Actor): string {
  if (actor.kind === "api_client" && actor.actingUser) {
    return `${actor.actingUser.name ?? actor.actingUser.id} via ${actor.name}`;
  }
  return actor.name;
}
