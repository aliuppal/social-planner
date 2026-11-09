import type { Metadata } from "next";
import { AtSign, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { userCtx } from "@/lib/auth/session";
import { getBrandStatus, listBrands } from "@/lib/services/brands";

export const metadata: Metadata = { title: "Dashboard · Social Planner" };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function DashboardPage() {
  const ctx = await userCtx();
  const brands = await listBrands(ctx);
  const statuses = await Promise.all(brands.map((b) => getBrandStatus(ctx, b.id)));
  const isClient = ctx.actor.kind === "user" && ctx.actor.role === "client";

  return (
    <>
      <h1 className="text-2xl font-semibold">Your brands</h1>
      <p className="mt-1 mb-6 text-muted-foreground">{isClient ? "The brands you have access to." : "Everything you manage, at a glance."}</p>

      {brands.length === 0 ? (
        <div className="glass rounded-[22px] p-8 text-center text-muted-foreground">You don&apos;t have access to any brands yet. Ask an owner to add you.</div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {brands.map((b, i) => {
            const s = statuses[i];
            const daily = b.postingSlots.length === 7 && new Set(b.postingSlots.map((p) => p.time)).size === 1;
            const slots = daily ? `Daily ${b.postingSlots[0].time}` : b.postingSlots.map((p) => `${DAYS[p.weekday]} ${p.time}`).join(", ") || "No posting slots";
            return (
              <li key={b.id} className="glass rounded-[22px] p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="flex items-center gap-2 font-medium">
                      <span aria-hidden className="size-2.5 rounded-full" style={{ background: b.color }} />
                      {b.name}
                    </p>
                    <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                      <AtSign className="size-3.5" aria-hidden /> {b.instagramHandle?.slice(1) ?? "no handle"}
                      <span className="mx-1">·</span>
                      {s.instagram.connected ? "connected" : "not connected"}
                    </p>
                  </div>
                  {b.requiresApproval && <Badge variant="secondary">Approval required</Badge>}
                </div>
                <p className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Clock className="size-3.5" aria-hidden /> {slots} · {b.timezone}
                </p>
                <dl className="mt-4 grid grid-cols-4 gap-2 text-center">
                  {(
                    [
                      ["Scheduled", s.counts.scheduled],
                      ["Awaiting", s.counts.awaitingApproval],
                      ["Failed", s.counts.failed],
                      ["Missed", s.counts.missed],
                    ] as const
                  ).map(([label, n]) => (
                    <div key={label} className="rounded-[14px] bg-inset px-2 py-2.5">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="text-lg font-semibold tabular-nums">{n}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
