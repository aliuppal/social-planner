import type { Metadata } from "next";
import { can } from "@/lib/auth/guard";
import { requireActor, userCtx } from "@/lib/auth/session";
import { getAccessibleBrand, listBrands } from "@/lib/services/brands";
import { listPosts } from "@/lib/services/posts";
import { LiveRefresh } from "@/components/app/live";
import { Board } from "@/components/board/board";

export const metadata: Metadata = { title: "Board · Social Planner" };

const OPEN = ["idea", "draft", "awaiting_approval", "approved", "rejected", "scheduled", "publishing", "failed"] as const;

export default async function BoardPage({ searchParams }: PageProps<"/board">) {
  const actor = await requireActor();
  const ctx = await userCtx();
  const sp = await searchParams;
  const brands = await listBrands(ctx);
  const brandId = typeof sp.brand === "string" && brands.some((b) => b.id === sp.brand) ? sp.brand : undefined;

  const [open, recent] = await Promise.all([
    listPosts(ctx, { brandId, status: [...OPEN], limit: 200 }),
    listPosts(ctx, { brandId, status: ["published"], from: new Date(ctx.now().getTime() - 14 * 86_400_000).toISOString(), limit: 50 }),
  ]);

  const perms: Record<string, { submit: boolean; approve: boolean; schedule: boolean }> = {};
  for (const b of brands) {
    const full = await getAccessibleBrand(ctx, b.id);
    perms[b.id] = { submit: can(actor, "post.submit", full).ok, approve: can(actor, "post.approve", full).ok, schedule: can(actor, "post.schedule", full).ok };
  }

  return (
    <>
      <LiveRefresh />
      <Board
        posts={[...open.posts, ...recent.posts].map((p) => ({ id: p.id, brandId: p.brandId, status: p.status, type: p.type, source: p.source, caption: p.caption, thumbnailUrl: p.thumbnailUrl, scheduledAtLocal: p.scheduledAtLocal ?? null, version: p.version }))}
        brands={brands.map((b) => ({ id: b.id, name: b.name, color: b.color }))}
        perms={perms}
        brandId={brandId ?? null}
      />
    </>
  );
}
