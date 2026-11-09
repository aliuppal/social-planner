import Link from "next/link";
import { FormMessage } from "@/components/auth/field";
import { ResetForm } from "./reset-form";

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : undefined;
  return (
    <>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">At least 10 characters. A short phrase works well.</p>
      {token ? <ResetForm token={token} /> : <FormMessage>This reset link is invalid or has expired.</FormMessage>}
      <Link href="/forgot-password" className="mt-6 block text-center text-sm text-muted-foreground hover:text-foreground">
        Request a new link
      </Link>
    </>
  );
}
