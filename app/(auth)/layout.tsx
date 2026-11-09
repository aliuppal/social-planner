import Link from "next/link";
import { Suspense } from "react";

/** Centered glass card on the inqi wash, used by login, reset and invite pages. Content reads the request, so it streams. */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-8 text-2xl font-bold tracking-tight">
        planner<span className="text-primary">.</span>
      </Link>
      <div className="glass w-full max-w-[420px] rounded-[28px] p-6 sm:p-8">
        <Suspense fallback={<div aria-busy="true" aria-label="Loading" className="h-64 animate-pulse rounded-[20px] bg-muted" />}>{children}</Suspense>
      </div>
    </main>
  );
}
