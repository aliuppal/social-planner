import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/guard";
import { requireActor, userCtx } from "@/lib/auth/session";
import { getAccessibleBrand } from "@/lib/services/brands";
import { getPost, listPosts } from "@/lib/services/posts";
import { PostEditor } from "@/components/post/post-editor";
import { LiveRefresh } from "@/components/app/live";

export const metadata: Metadata = { title: "Post · Social Planner" };

export default async function PostPage({ params }: PageProps<"/posts/[id]">) {
  const { id } = await params;
  const actor = await requireActor();
  const ctx = await userCtx();
  const post = await getPost(ctx, id).catch(() => null);
  if (!post) notFound();
  const brand = await getAccessibleBrand(ctx, post.brandId);
  const recent = await listPosts(ctx, { brandId: brand.id, status: ["published", "scheduled"], from: new Date(ctx.now().getTime() - 120 * 86_400_000).toISOString(), limit: 200 });
  const grid = recent.posts
    .filter((p) => p.id !== post.id)
    .slice(-8)
    .reverse()
    .map((p) => ({ id: p.id, thumbnailUrl: p.thumbnailUrl }));
  const allowed = (a: Parameters<typeof can>[1]) => can(actor, a, brand).ok;

  return (
    <>
      <LiveRefresh />
      <PostEditor
        key={post.version}
        post={post}
        brand={{ id: brand.id, name: brand.name, handle: brand.instagramHandle ?? brand.slug, color: brand.color, timezone: brand.timezone, requiresApproval: brand.requiresApproval, guidelines: brand.guidelines }}
        perms={{ edit: allowed("post.edit"), submit: allowed("post.submit"), approve: allowed("post.approve"), schedule: allowed("post.schedule"), publish: allowed("post.publish"), comment: allowed("post.comment") }}
        grid={grid}
      />
    </>
  );
}
