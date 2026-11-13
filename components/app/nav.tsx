"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, CheckCircle2, Columns3, Home, KeyRound, Store, Users } from "lucide-react";
import { cn } from "cn";

const ITEMS = [
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/board", label: "Board", icon: Columns3 },
  { href: "/approvals", label: "Approvals", icon: CheckCircle2 },
  { href: "/brands", label: "Brands", icon: Store },
  { href: "/dashboard", label: "Overview", icon: Home },
] as const;
const OWNER_ITEMS = [
  { href: "/settings/team", label: "Team", icon: Users },
  { href: "/settings/api-clients", label: "API keys", icon: KeyRound },
] as const;

const active = (path: string, href: string) => path === href || path.startsWith(`${href}/`);

/** Desktop sidebar. */
export function SideNav({ isOwner }: { isOwner: boolean }) {
  const path = usePathname();
  const items = [...ITEMS, ...(isOwner ? OWNER_ITEMS : [])];
  return (
    <nav aria-label="Main" className="grid gap-1">
      {items.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={active(path, href) ? "page" : undefined}
          className={cn(
            "flex min-h-11 items-center gap-3 rounded-full px-4 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            active(path, href) && "bg-violet-soft font-medium text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden /> {label}
        </Link>
      ))}
    </nav>
  );
}

/** Phone: inqi-style floating dock. */
export function DockNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main mobile" className="glass fixed inset-x-3 bottom-3 z-40 flex justify-around rounded-[28px] px-2 py-1.5 lg:hidden" style={{ paddingBottom: "max(6px, env(safe-area-inset-bottom))" }}>
      {ITEMS.slice(0, 4).map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={active(path, href) ? "page" : undefined}
          className={cn("flex min-h-12 min-w-16 flex-col items-center justify-center gap-0.5 rounded-[18px] px-2 text-[11px] text-muted-foreground", active(path, href) && "bg-accent text-foreground")}
        >
          <Icon className="size-5" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
