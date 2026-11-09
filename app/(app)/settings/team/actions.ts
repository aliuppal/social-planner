"use server";

import { revalidatePath } from "next/cache";
import { userCtx } from "@/lib/auth/session";
import { toAppError } from "@/lib/errors";
import { appUrl } from "@/lib/runtime";
import { createInvite, revokeInvite, updateMember } from "@/lib/services/users";

export type ActionResult = { ok?: boolean; error?: string; url?: string; emailed?: boolean };

export async function inviteAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const res = await createInvite(
      await userCtx(),
      { email: String(form.get("email") ?? ""), role: String(form.get("role")) as "owner" | "manager" | "client", brandIds: form.getAll("brandIds").map(String) },
      appUrl(),
    );
    revalidatePath("/settings/team");
    return { ok: true, url: res.url, emailed: res.emailed };
  } catch (err) {
    return { error: toAppError(err).message };
  }
}

export async function updateMemberAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    await updateMember(await userCtx(), {
      userId: String(form.get("userId")),
      role: String(form.get("role")) as "owner" | "manager" | "client",
      brandIds: form.getAll("brandIds").map(String),
      disabled: form.get("disabled") === "on",
      externalUserId: String(form.get("externalUserId") ?? "") || null,
    });
    revalidatePath("/settings/team");
    return { ok: true };
  } catch (err) {
    return { error: toAppError(err).message };
  }
}

export async function revokeInviteAction(inviteId: string): Promise<ActionResult> {
  try {
    await revokeInvite(await userCtx(), inviteId);
    revalidatePath("/settings/team");
    return { ok: true };
  } catch (err) {
    return { error: toAppError(err).message };
  }
}
