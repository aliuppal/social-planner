import Link from "next/link";
import { Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { SignOutButton } from "@/components/app/sign-out-button";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { requireActor } from "@/lib/auth/session";

/**
 * Signed-in shell. The frame is static (prerendered); anything that reads the session
 * streams in behind <Suspense>. Each page validates the session itself.
 * Full navigation (calendar, board, approvals) arrives in phase 4.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col px-[clamp(16px,4vw,40px)] py-6">
      <header className="mb-8 flex items-center justify-between gap-3">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="text-2xl font-bold tracking-tight">
            planner<span className="text-primary">.</span>
          </Link>
          <Suspense>
            <MainNav />
          </Suspense>
        </div>
        <div className="flex items-center gap-2">
          <Suspense fallback={<span className="glass hidden h-11 w-40 animate-pulse rounded-full sm:inline-block" />}>
            <UserChip />
          </Suspense>
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1">
        <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
      </main>
      <Toaster />
    </div>
  );
}

async function MainNav() {
  const actor = await requireActor();
  const nav = [{ href: "/dashboard", label: "Dashboard" }, ...(actor.role === "owner" ? [{ href: "/settings/team", label: "Team" }] : [])];
  return (
    <nav aria-label="Main" className="flex gap-1">
      {nav.map((n) => (
        <Link key={n.href} href={n.href} className="rounded-full px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground sm:px-4">
          {n.label}
        </Link>
      ))}
    </nav>
  );
}

async function UserChip() {
  const actor = await requireActor();
  return (
    <span className="glass hidden rounded-full px-4 py-2.5 text-sm sm:inline">
      {actor.name} <span className="text-muted-foreground">· {actor.role}</span>
    </span>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="grid gap-3">
      <div className="h-8 w-48 animate-pulse rounded-full bg-muted" />
      <div className="h-4 w-72 animate-pulse rounded-full bg-muted" />
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="glass h-44 animate-pulse rounded-[22px]" />
        <div className="glass h-44 animate-pulse rounded-[22px]" />
      </div>
    </div>
  );
}
