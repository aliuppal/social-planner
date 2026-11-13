import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, Camera, CheckCircle2 } from "lucide-react";
import { can } from "@/lib/auth/guard";
import { requireActor, userCtx } from "@/lib/auth/session";
import { getAccessibleBrand, getBrand, getBrandStatus } from "@/lib/services/brands";
import { listCalendars } from "@/lib/services/calendars";
import { BrandSettingsForm, CalendarsManager, GuidelinesForm, SlotsEditor } from "@/components/brand/brand-forms";

export const metadata: Metadata = { title: "Brand · Social Planner" };

export default async function BrandPage({ params }: PageProps<"/brands/[slug]">) {
  const { slug } = await params;
  const actor = await requireActor();
  const ctx = await userCtx();
  const brand = await getBrand(ctx, slug).catch(() => null);
  if (!brand) notFound();
  const [status, calendars, full] = await Promise.all([getBrandStatus(ctx, brand.id), listCalendars(ctx, { brandId: brand.id, includeArchived: true }), getAccessibleBrand(ctx, brand.id)]);
  const canWrite = can(actor, "brand.write", full).ok;
  const canCal = can(actor, "calendar.write", full).ok;
  const ig = status.instagram;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/brands" className="text-sm text-muted-foreground hover:text-foreground">
          ← Brands
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <span aria-hidden className="size-3.5 rounded-full" style={{ background: brand.color }} /> {brand.name}
        </h1>
        <Link href={`/calendar?scope=brand:${brand.id}`} className="ml-auto text-sm text-primary hover:underline">
          Open calendar
        </Link>
      </div>

      <section aria-labelledby="status-h" className="glass grid gap-4 rounded-[22px] p-5">
        <h2 id="status-h" className="font-medium">
          Status
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-start gap-3 rounded-[18px] bg-inset p-4">
            <Camera className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
            <div className="text-sm">
              {ig.connected && "username" in ig ? (
                <>
                  <p className="flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="size-4 text-success" aria-hidden /> @{ig.username} connected
                  </p>
                  {ig.tokenDaysLeft !== null && <p className="text-muted-foreground">Token renews automatically; {ig.tokenDaysLeft} days left.</p>}
                  {ig.publishQuota && (
                    <p className="text-muted-foreground">
                      Publishing quota: {ig.publishQuota.remaining} of {ig.publishQuota.total} left (24 h)
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="font-medium">Instagram not connected</p>
                  <p className="text-muted-foreground">Connecting {brand.instagramHandle ?? "the account"} arrives with publishing in phase 5. Until then posts can be planned and approved but not published.</p>
                </>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-4 gap-2 text-center">
            {(
              [
                ["Scheduled", status.counts.scheduled],
                ["Awaiting", status.counts.awaitingApproval],
                ["Failed", status.counts.failed],
                ["Missed", status.counts.missed],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-[14px] bg-inset px-1 py-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-xl font-semibold tabular-nums">{n}</dd>
              </div>
            ))}
          </dl>
        </div>
        {status.failedPosts.length > 0 && (
          <ul className="grid gap-1 text-sm">
            {status.failedPosts.map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <Link href={`/posts/${f.id}`} className="hover:underline">
                  {f.error ?? "Failed"}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <BrandSettingsForm brand={brand} canWrite={canWrite} />
        <SlotsEditor brandId={brand.id} timezone={brand.timezone} slots={brand.postingSlots} canWrite={canWrite} />
      </div>
      <GuidelinesForm brandId={brand.id} guidelines={brand.guidelines} canWrite={canWrite} />
      <CalendarsManager brandId={brand.id} calendars={calendars.filter((c) => c.kind === "custom")} canWrite={canCal} />
    </div>
  );
}
