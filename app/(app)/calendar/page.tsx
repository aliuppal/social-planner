import type { Metadata } from "next";
import { can } from "@/lib/auth/guard";
import { requireActor, userCtx } from "@/lib/auth/session";
import { getAccessibleBrand, listBrands } from "@/lib/services/brands";
import { listCalendars } from "@/lib/services/calendars";
import { CalendarView } from "@/components/calendar/calendar-view";

export const metadata: Metadata = { title: "Calendar · Social Planner" };

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const actor = await requireActor();
  const ctx = await userCtx();
  const sp = await searchParams;
  const [brands, calendars] = await Promise.all([listBrands(ctx), listCalendars(ctx)]);
  // permission flags so the UI only offers what the server will allow
  const brandOpts = await Promise.all(
    brands.map(async (b) => {
      const full = await getAccessibleBrand(ctx, b.id);
      return {
        id: b.id,
        slug: b.slug,
        name: b.name,
        color: b.color,
        timezone: b.timezone,
        firstSlot: b.postingSlots[0]?.time ?? "09:00",
        canCreate: can(actor, "post.create", full).ok,
        canSchedule: can(actor, "post.schedule", full).ok,
      };
    }),
  );
  return (
    <CalendarView
      brands={brandOpts}
      calendars={calendars.filter((c) => c.kind === "custom").map((c) => ({ id: c.id, name: c.name, color: c.color, brandId: c.brandId }))}
      initialScope={typeof sp.scope === "string" ? sp.scope : brandOpts.length === 1 ? `brand:${brandOpts[0].id}` : "all"}
    />
  );
}
