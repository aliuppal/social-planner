/**
 * The planner talks to Instagram only through this interface.
 * - `MockInstagramClient` (lib/instagram/mock.ts): tests and local dev (INSTAGRAM_CLIENT=mock)
 * - real Graph API client (phase 5, graph.instagram.com, Instagram API with Instagram Login)
 */

export type IgAuth = { igUserId: string; accessToken: string };

/** Documented container status codes. */
export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED";

export type CreateContainerInput =
  | { kind: "image"; imageUrl: string; caption?: string; altText?: string; isAiGenerated?: boolean }
  | { kind: "reel"; videoUrl: string; caption?: string; coverUrl?: string; isAiGenerated?: boolean }
  /** carousel children: no caption, no is_ai_generated (per docs) */
  | { kind: "carousel_item"; imageUrl?: string; videoUrl?: string; altText?: string }
  | { kind: "carousel"; children: string[]; caption?: string; isAiGenerated?: boolean };

export type IgMedia = {
  id: string;
  caption?: string;
  mediaType: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  mediaProductType?: "FEED" | "REELS" | "STORY" | "AD";
  permalink?: string;
  timestamp: Date;
  mediaUrl?: string;
  thumbnailUrl?: string;
};

export type PublishingLimit = { used: number; total: number };

export interface InstagramClient {
  createContainer(auth: IgAuth, input: CreateContainerInput): Promise<{ id: string }>;
  getContainerStatus(auth: IgAuth, containerId: string): Promise<{ status: ContainerStatus; message?: string }>;
  publishContainer(auth: IgAuth, containerId: string): Promise<{ mediaId: string }>;
  getMedia(auth: IgAuth, mediaId: string): Promise<IgMedia>;
  listRecentMedia(auth: IgAuth, opts: { limit: number; since?: Date }): Promise<IgMedia[]>;
  postComment(auth: IgAuth, mediaId: string, message: string): Promise<{ id: string }>;
  getPublishingLimit(auth: IgAuth): Promise<PublishingLimit>;
}

/** Errors from Instagram. `transient` = worth retrying (rate limits, 5xx, timeouts). */
export class InstagramApiError extends Error {
  constructor(
    message: string,
    public opts: { code?: number; subcode?: number; status?: number; transient: boolean },
  ) {
    super(message);
    this.name = "InstagramApiError";
  }
  get transient() {
    return this.opts.transient;
  }
}
