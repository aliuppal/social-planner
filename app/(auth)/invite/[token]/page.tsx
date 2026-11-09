import Link from "next/link";
import { FormMessage } from "@/components/auth/field";
import { getDb } from "@/lib/db";
import { findInvite } from "@/lib/services/users";
import { InviteForm } from "./invite-form";

const ROLE_TEXT = { owner: "an owner", manager: "a manager", client: "a client" } as const;

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const invite = await findInvite(getDb(), token).catch(() => null);
  if (!invite) {
    return (
      <>
        <h1 className="mb-4 text-xl font-semibold">Invite not available</h1>
        <FormMessage>This invite link is invalid, already used or expired. Ask the person who invited you for a new one.</FormMessage>
        <Link href="/login" className="mt-6 block text-center text-sm text-muted-foreground hover:text-foreground">
          Already have an account? Sign in
        </Link>
      </>
    );
  }
  return (
    <>
      <h1 className="text-xl font-semibold">Welcome to Social Planner</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        You&apos;re joining as {ROLE_TEXT[invite.role]} with <span className="text-foreground">{invite.email}</span>. Choose your name and a password.
      </p>
      <InviteForm token={token} />
    </>
  );
}
