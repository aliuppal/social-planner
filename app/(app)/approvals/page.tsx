import type { Metadata } from "next";
import { can } from "@/lib/auth/guard";
import { requireActor, userCtx } from "@/lib/auth/session";
import { getAccessibleBrand, listBrands } from "@/lib/services/brands";
import { listMedia } from "@/lib/services/media";
import { listPosts } from "@/lib/services/posts";
import { LiveRefresh } from "@/components/app/live";
import { ApprovalQueue } from "@/components/approvals/approval-queue";

export const metadata: Metadata = { title: "Approvals · Social Planner" };

export default async function ApprovalsPage() {
  const actor = await requireActor();
  const ctx = await userCtx();
  const [brands, queue] = await Promise.all([listBrands(ctx), listPosts(ctx, { status: ["awaiting_approval"], limit: 100 })]);
  const brandBy = new Map(brands.map((b) => [b.id, b]));
  const canApprove = new Map<string, boolean>();
  for (const b of brands) canApprove.set(b.id, can(actor, "post.approve", await getAccessibleBrand(ctx, b.id)).ok);

  const items = await Promise.all(
    queue.posts.map(async (p) => ({
      id: p.id,
      brand: { name: brandBy.get(p.brandId)?.name ?? "", color: brandBy.get(p.brandId)?.color ?? "#8b7bff", timezone: brandBy.get(p.brandId)?.timezone ?? "UTC" },
      type: p.type,
      source: p.source,
      caption: p.caption,
      hashtags: p.hashtags,
      scheduledAtLocal: p.scheduledAtLocal ?? null,
      media: (await listMedia(ctx.db, p.id)).map((m) => ({ url: m.url, mimeType: m.mimeType, altText: m.altText })),
      canApprove: canApprove.get(p.brandId) ?? false,
    })),
  );

  return (
    <>
      <LiveRefresh />
      <div className="mx-auto grid max-w-2xl gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Approvals</h1>
          <p className="mt-1 text-muted-foreground">{items.length ? `${items.length} post${items.length === 1 ? "" : "s"} waiting for a decision.` : "Nothing waiting. New submissions appear here automatically."}</p>
        </div>
        <ApprovalQueue items={items} />
      </div>
    </>
  );
}
