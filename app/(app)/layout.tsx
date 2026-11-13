import Link from "next/link";
import { Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { DockNav, SideNav } from "@/components/app/nav";
import { SignOutButton } from "@/components/app/sign-out-button";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { requireActor } from "@/lib/auth/session";

/**
 * Signed-in shell: sidebar on desktop, inqi-style dock on phones.
 * The frame is static; anything reading the session streams in behind <Suspense>.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-1 gap-6 px-[clamp(12px,3vw,28px)] py-5">
      <aside className="sticky top-5 hidden h-[calc(100dvh-40px)] w-56 shrink-0 flex-col gap-6 lg:flex">
        <Link href="/calendar" className="px-4 text-2xl font-bold tracking-tight">
          planner<span className="text-primary">.</span>
        </Link>
        <Suspense fallback={<div className="grid gap-1">{Array.from({ length: 5 }, (_, i) => <div key={i} className="h-11 animate-pulse rounded-full bg-muted" />)}</div>}>
          <Sidebar />
        </Suspense>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="mb-5 flex items-center justify-between gap-3">
          <Link href="/calendar" className="text-2xl font-bold tracking-tight lg:invisible">
            planner<span className="text-primary">.</span>
          </Link>
          <div className="flex items-center gap-2">
            <Suspense fallback={<span className="glass hidden h-11 w-40 animate-pulse rounded-full sm:inline-block" />}>
              <UserChip />
            </Suspense>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </header>
        <main className="flex-1 pb-24 lg:pb-6">
          <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
        </main>
      </div>
      <Suspense>
        <DockNav />
      </Suspense>
      <Toaster />
    </div>
  );
}

async function Sidebar() {
  const actor = await requireActor();
  return <SideNav isOwner={actor.role === "owner"} />;
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
      <div className="glass mt-4 h-[60vh] animate-pulse rounded-[22px]" />
    </div>
  );
}
