import type { Metadata } from "next";
import Link from "next/link";
import { AtSign, Clock, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireActor, userCtx } from "@/lib/auth/session";
import { listBrands } from "@/lib/services/brands";
import { WEEKDAYS } from "@/lib/ui/meta";

export const metadata: Metadata = { title: "Brands · Social Planner" };

export default async function BrandsPage() {
  const actor = await requireActor();
  const brands = await listBrands(await userCtx());
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">Brands</h1>
        {actor.role === "owner" && (
          <Button render={<Link href="/brands/new" />}>
            <Plus aria-hidden /> New brand
          </Button>
        )}
      </div>
      {brands.length === 0 ? (
        <p className="glass rounded-[22px] p-8 text-center text-muted-foreground">No brands yet.</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {brands.map((b) => {
            const daily = b.postingSlots.length === 7 && new Set(b.postingSlots.map((s) => s.time)).size === 1;
            return (
              <li key={b.id}>
                <Link href={`/brands/${b.slug}`} className="glass block rounded-[22px] p-5 transition-colors hover:border-primary">
                  <div className="flex items-start justify-between gap-2">
                    <p className="flex items-center gap-2 font-medium">
                      <span aria-hidden className="size-3 rounded-full" style={{ background: b.color }} /> {b.name}
                    </p>
                    {b.requiresApproval && <Badge variant="secondary">Approval</Badge>}
                  </div>
                  <p className="mt-2 flex items-center gap-1 text-sm text-muted-foreground">
                    <AtSign className="size-3.5" aria-hidden /> {b.instagramHandle?.slice(1) ?? "no handle"} · {b.instagram?.status ?? "not connected"}
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                    <Clock className="size-3.5" aria-hidden />
                    {daily ? `Daily ${b.postingSlots[0].time}` : b.postingSlots.map((s) => `${WEEKDAYS[s.weekday]} ${s.time}`).join(", ") || "No posting slots"} · {b.timezone}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
