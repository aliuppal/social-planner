import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { eq } from "drizzle-orm";
import { assertCan } from "@/lib/auth/guard";
import { getSessionActor } from "@/lib/auth/session";
import { posts } from "@/lib/db/schema";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { IG_LIMITS } from "@/lib/instagram/limits";
import { getDeps } from "@/lib/runtime";
import { withActor } from "@/lib/services/context";
import { getAccessibleBrand } from "@/lib/services/brands";

/**
 * Issues short-lived Vercel Blob upload tokens so the browser uploads media directly
 * (Vercel functions cap request bodies at 4.5 MB). The editor then imports the uploaded file,
 * which converts images to JPEG and deletes the raw upload.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const actor = await getSessionActor();
        if (!actor) throw new Error("Sign in again.");
        if (!pathname.startsWith("uploads/")) throw new Error("Invalid upload path.");
        const [p] = await getDb().select({ brandId: posts.brandId }).from(posts).where(eq(posts.id, clientPayload ?? ""));
        if (!p) throw new Error("Post not found.");
        const brand = await getAccessibleBrand(withActor(getDeps(), actor), p.brandId);
        assertCan(actor, "post.edit", brand);
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"],
          maximumSizeInBytes: IG_LIMITS.reel.maxBytes,
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // nothing to do: the editor imports the file right after upload
      },
    });
    return Response.json(result);
  } catch (err) {
    const message = err instanceof AppError || err instanceof Error ? err.message : "Upload failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
