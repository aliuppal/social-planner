/**
 * Instagram publishing limits, taken from the official Meta docs (checked 2026-11-09):
 * - https://developers.facebook.com/docs/instagram-platform/content-publishing
 * - https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 * Re-check these when Meta changes the platform; every validator reads from here.
 */
export const IG_LIMITS = {
  caption: { maxChars: 2200, maxHashtags: 30, maxMentions: 20 },
  altText: { maxChars: 1000 },
  carousel: { minItems: 2, maxItems: 20 },
  image: {
    mimeTypes: ["image/jpeg"] as readonly string[],
    maxBytes: 8 * 1024 * 1024,
    /** width / height */
    minAspect: 4 / 5,
    maxAspect: 1.91,
    minWidth: 320,
  },
  reel: {
    mimeTypes: ["video/mp4", "video/quicktime"] as readonly string[],
    maxBytes: 300 * 1024 * 1024,
    minDurationMs: 3_000,
    maxDurationMs: 15 * 60_000,
    minAspect: 0.01,
    maxAspect: 10,
    maxWidth: 1920,
  },
  /** API-published posts per rolling 24h. Docs say 100 in one place and 50 in another: read the live value from /content_publishing_limit. */
  publishPer24hFallback: 50,
  containerTtlMs: 24 * 60 * 60_000,
  /** Docs: poll status once per minute for no more than 5 minutes. */
  containerPoll: { intervalMs: 60_000, maxPolls: 5 },
} as const;
