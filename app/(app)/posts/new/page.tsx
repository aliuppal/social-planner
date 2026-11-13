import type { Metadata } from "next";
import { can } from "@/lib/auth/guard";
import { requireActor, userCtx } from "@/lib/auth/session";
import { getAccessibleBrand, listBrands } from "@/lib/services/brands";
import { listCalendars } from "@/lib/services/calendars";
import { NewPostForm } from "@/components/post/new-post-form";

export const metadata: Metadata = { title: "New post · Social Planner" };

export default async function NewPostPage({ searchParams }: PageProps<"/posts/new">) {
  const actor = await requireActor();
  const ctx = await userCtx();
  const sp = await searchParams;
  const brands = await listBrands(ctx);
  const allowed = [];
  for (const b of brands) if (can(actor, "post.create", await getAccessibleBrand(ctx, b.id)).ok) allowed.push(b);
  const calendars = (await listCalendars(ctx)).filter((c) => c.kind === "custom");
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return (
    <div className="mx-auto grid max-w-xl gap-4">
      <h1 className="text-2xl font-semibold">New post</h1>
      {allowed.length === 0 ? (
        <p className="glass rounded-[22px] p-6 text-muted-foreground">You can&apos;t create posts for any of your brands.</p>
      ) : (
        <NewPostForm
          brands={allowed.map((b) => ({ id: b.id, name: b.name, timezone: b.timezone }))}
          calendars={calendars.map((c) => ({ id: c.id, name: c.name, brandId: c.brandId }))}
          initial={{ brandId: str(sp.brand), at: str(sp.at), calendarId: str(sp.calendar) }}
        />
      )}
    </div>
  );
}
