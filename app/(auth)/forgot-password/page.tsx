"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/auth/field";
import { authClient } from "@/lib/auth/client";

export default function ForgotPasswordPage() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(form: FormData) {
    setPending(true);
    await authClient.requestPasswordReset({ email: String(form.get("email")), redirectTo: "/reset-password" });
    setPending(false);
    setSent(true);
  }

  return (
    <>
      <h1 className="text-xl font-semibold">Set or reset your password</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">We&apos;ll email you a link to choose a new password.</p>
      {sent ? (
        <FormMessage tone="success">If that email has an account, the link is on its way. It expires in 1 hour.</FormMessage>
      ) : (
        <form action={submit} className="grid gap-4">
          <Field id="email" name="email" label="Email" type="email" autoComplete="email" required />
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? "Sending…" : "Send link"}
          </Button>
        </form>
      )}
      <Link href="/login" className="mt-6 block text-center text-sm text-muted-foreground hover:text-foreground">
        Back to sign in
      </Link>
    </>
  );
}
