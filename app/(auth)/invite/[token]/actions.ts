"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/auth";
import { getDb } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { acceptInvite } from "@/lib/services/users";

export type AcceptState = { error?: string; fieldErrors?: Record<string, string> };

export async function acceptInviteAction(_prev: AcceptState, form: FormData): Promise<AcceptState> {
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("confirm") ?? "")) return { fieldErrors: { confirm: "The two passwords don't match." } };
  let email: string;
  try {
    ({ email } = await acceptInvite(getDb(), { token: String(form.get("token") ?? ""), name: String(form.get("name") ?? ""), password }));
  } catch (err) {
    const e = toAppError(err);
    const fieldErrors = Object.fromEntries((e.opts.details ?? []).filter((d) => d.field).map((d) => [d.field!, d.message]));
    return Object.keys(fieldErrors).length ? { fieldErrors } : { error: e.message };
  }
  // nextCookies() sets the session cookie on this response
  await getAuth().api.signInEmail({ body: { email, password }, headers: await headers() });
  redirect("/dashboard");
}
