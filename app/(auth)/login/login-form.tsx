"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Field, FormMessage } from "@/components/auth/field";
import { authClient, safeNext } from "@/lib/auth/client";

export function LoginForm({ next, linkError }: { next?: string; linkError?: string }) {
  const router = useRouter();
  const target = safeNext(next);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(linkError ? "That sign-in link is invalid or has expired. Request a new one." : null);
  const [linkSent, setLinkSent] = useState(false);

  async function withPassword(form: FormData) {
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({ email: String(form.get("email")), password: String(form.get("password")) });
    setPending(false);
    if (error) return setError(error.status === 403 ? (error.message ?? "This account is disabled.") : "Email or password is incorrect.");
    router.replace(target);
    router.refresh();
  }

  async function withLink(form: FormData) {
    setPending(true);
    setError(null);
    await authClient.signIn.magicLink({ email: String(form.get("email")), callbackURL: target, errorCallbackURL: "/login?error=link" });
    setPending(false);
    // same message whether or not the account exists
    setLinkSent(true);
  }

  return (
    <Tabs defaultValue="password" className="gap-5">
      <TabsList className="grid w-full grid-cols-2 rounded-full">
        <TabsTrigger value="password" className="rounded-full">Password</TabsTrigger>
        <TabsTrigger value="link" className="rounded-full">Email link</TabsTrigger>
      </TabsList>

      {error && <FormMessage>{error}</FormMessage>}

      <TabsContent value="password">
        <form action={withPassword} className="grid gap-4">
          <Field id="email" name="email" label="Email" type="email" autoComplete="email" required />
          <Field id="password" name="password" label="Password" type="password" autoComplete="current-password" required />
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
          <Link href="/forgot-password" className="text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Forgot or never set a password?
          </Link>
        </form>
      </TabsContent>

      <TabsContent value="link">
        {linkSent ? (
          <FormMessage tone="success">If that email has an account, a sign-in link is on its way. It works once and expires in 15 minutes.</FormMessage>
        ) : (
          <form action={withLink} className="grid gap-4">
            <Field id="link-email" name="email" label="Email" type="email" autoComplete="email" required />
            <Button type="submit" size="lg" disabled={pending}>
              {pending ? "Sending…" : "Email me a sign-in link"}
            </Button>
          </form>
        )}
      </TabsContent>
    </Tabs>
  );
}
