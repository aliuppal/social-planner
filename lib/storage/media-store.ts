import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import sharp from "sharp";
import { IG_LIMITS } from "@/lib/instagram/limits";
import { readCapped, safeFetch } from "@/lib/net/safe-fetch";
import type { MediaStore, StoredMedia } from "@/lib/services/context";

const MAX_IMAGE_DOWNLOAD = 40 * 1024 * 1024;
const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov" };

/**
 * Copies media from a public URL into Vercel Blob (Instagram fetches media by public URL).
 * Images are measured and, when needed, normalised for Instagram: sRGB JPEG, EXIF-rotated,
 * at most 1440px wide (Instagram's max). Videos are stored as-is.
 * With upload=false (local dev without BLOB_READ_WRITE_TOKEN) it only measures and keeps the source URL.
 */
export class BlobMediaStore implements MediaStore {
  constructor(private opts: { upload: boolean }) {}

  async importFromUrl(sourceUrl: string, ctx: { brandId: string; postId: string }): Promise<StoredMedia> {
    const res = await safeFetch(sourceUrl, { maxBytes: IG_LIMITS.reel.maxBytes });
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = new URL(sourceUrl).pathname.split(".").pop()?.toLowerCase() ?? "";
    const videoExt = VIDEO_TYPES[type] ?? (["mp4", "mov"].includes(ext) ? ext : undefined);

    if (videoExt) {
      const mimeType = videoExt === "mov" ? "video/quicktime" : "video/mp4";
      const sizeBytes = Number(res.headers.get("content-length") ?? 0) || undefined;
      if (!this.opts.upload) {
        await res.body?.cancel();
        return { url: sourceUrl, mimeType, sizeBytes };
      }
      const blob = await put(`media/${ctx.brandId}/${ctx.postId}/${randomUUID()}.${videoExt}`, res.body!, { access: "public", contentType: mimeType, addRandomSuffix: false });
      return { url: blob.url, mimeType, sizeBytes };
    }

    const input = await readCapped(res, MAX_IMAGE_DOWNLOAD);
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      meta = await sharp(input).metadata();
    } catch {
      throw new Error(`Not a readable image or video (content-type ${type || "unknown"})`);
    }

    if (!this.opts.upload) {
      // dev without Blob: report the source as it is; validation will flag non-JPEG
      return { url: sourceUrl, mimeType: `image/${meta.format === "jpeg" ? "jpeg" : meta.format}`, width: meta.width, height: meta.height, sizeBytes: input.byteLength };
    }

    const needsConvert = meta.format !== "jpeg" || (meta.width ?? 0) > 1440 || (meta.orientation ?? 1) !== 1 || (meta.space !== undefined && meta.space !== "srgb");
    const out = needsConvert
      ? await sharp(input).rotate().resize({ width: 1440, withoutEnlargement: true }).toColorspace("srgb").jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true })
      : { data: input, info: { width: meta.width!, height: meta.height! } };
    const blob = await put(`media/${ctx.brandId}/${ctx.postId}/${randomUUID()}.jpg`, out.data, { access: "public", contentType: "image/jpeg", addRandomSuffix: false });
    return { url: blob.url, mimeType: "image/jpeg", width: out.info.width, height: out.info.height, sizeBytes: out.data.byteLength };
  }
}
