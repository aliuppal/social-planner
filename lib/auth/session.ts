import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/auth";
import type { UserActor } from "@/lib/auth/guard";
import { getDb } from "@/lib/db";
import { getDeps } from "@/lib/runtime";
import { withActor, type Ctx } from "@/lib/services/context";
import { loadUserActor } from "@/lib/services/users";

/** The signed-in user as an actor (role + brand memberships), once per request. Null when signed out or disabled. */
export const getSessionActor = cache(async (): Promise<(UserActor & { email: string }) | null> => {
  // read headers first: it marks the route as dynamic before anything touches the database
  const h = await headers();
  const session = await getAuth().api.getSession({ headers: h });
  if (!session) return null;
  const actor = await loadUserActor(getDb(), session.user.id);
  return actor ? { ...actor, email: session.user.email } : null;
});

export async function requireActor(): Promise<UserActor & { email: string }> {
  const actor = await getSessionActor();
  if (!actor) redirect("/login");
  return actor;
}

export async function requireOwner() {
  const actor = await requireActor();
  if (actor.role !== "owner") redirect("/dashboard");
  return actor;
}

/** Service context for the signed-in user (server components and server actions). */
export async function userCtx(): Promise<Ctx> {
  const actor = await requireActor(); // before getDeps(): keeps the route dynamic and DB-free at build time
  return withActor(getDeps(), actor);
}
