"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/auth/field";
import { acceptInviteAction, type AcceptState } from "./actions";

export function InviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(acceptInviteAction, {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4">
      {state.error && <FormMessage>{state.error}</FormMessage>}
      <input type="hidden" name="token" value={token} />
      <Field id="name" name="name" label="Your name" autoComplete="name" required error={fe.name} />
      <Field id="password" name="password" label="Password" type="password" autoComplete="new-password" minLength={10} required error={fe.password} hint="At least 10 characters." />
      <Field id="confirm" name="confirm" label="Repeat password" type="password" autoComplete="new-password" minLength={10} required error={fe.confirm} />
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Setting up…" : "Create account"}
      </Button>
    </form>
  );
}
