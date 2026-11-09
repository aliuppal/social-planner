"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/auth/field";
import { authClient } from "@/lib/auth/client";

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(form: FormData) {
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) return setError("The two passwords don't match.");
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token });
    setPending(false);
    if (error) return setError(error.message?.toLowerCase().includes("short") ? "Use at least 10 characters." : "This reset link is invalid or has expired.");
    router.replace("/login");
  }

  return (
    <form action={submit} className="grid gap-4">
      {error && <FormMessage>{error}</FormMessage>}
      <Field id="password" name="password" label="New password" type="password" autoComplete="new-password" minLength={10} required />
      <Field id="confirm" name="confirm" label="Repeat password" type="password" autoComplete="new-password" minLength={10} required />
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Saving…" : "Save password"}
      </Button>
    </form>
  );
}
