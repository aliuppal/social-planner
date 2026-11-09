import type { ContainerStatus, CreateContainerInput, IgAuth, IgMedia, InstagramClient, PublishingLimit } from "./client";
import { InstagramApiError } from "./client";

type Container = { id: string; input: CreateContainerInput; status: ContainerStatus; polls: number; mediaId?: string; createdAt: Date };
type Method = keyof InstagramClient;

/**
 * In-memory Instagram used by tests and by local dev before a real account is connected.
 * - `failNext(method, err)` makes the next call to `method` throw.
 * - `videoPollsUntilReady` makes reels report IN_PROGRESS for that many status checks.
 */
export class MockInstagramClient implements InstagramClient {
  containers = new Map<string, Container>();
  media = new Map<string, IgMedia>();
  comments: { mediaId: string; message: string }[] = [];
  calls: { method: Method; args: unknown[] }[] = [];
  publishLimit: PublishingLimit = { used: 0, total: 100 };
  videoPollsUntilReady = 0;
  private failures = new Map<Method, Error[]>();
  private seq = 0;

  constructor(private now: () => Date = () => new Date()) {}

  failNext(method: Method, err: Error = new InstagramApiError("mock failure", { transient: true })) {
    const list = this.failures.get(method) ?? [];
    list.push(err);
    this.failures.set(method, list);
  }

  /** Simulate a post made directly in the Instagram app. */
  addExternalMedia(m: Partial<IgMedia> & { caption?: string }): IgMedia {
    const id = `ig_media_${++this.seq}`;
    const media: IgMedia = { id, mediaType: "IMAGE", mediaProductType: "FEED", timestamp: this.now(), permalink: `https://www.instagram.com/p/${id}/`, ...m };
    this.media.set(media.id, media);
    return media;
  }

  private lostResponses = new Set<Method>();

  /** The next call to `method` takes effect on "Instagram" but the caller gets an error (response lost / process crashed). */
  loseResponseNext(method: Method) {
    this.lostResponses.add(method);
  }

  private exit(method: Method) {
    if (this.lostResponses.delete(method)) throw new Error(`connection reset after ${method} (simulated crash)`);
  }

  private enter(method: Method, args: unknown[]) {
    this.calls.push({ method, args });
    const queued = this.failures.get(method);
    const err = queued?.shift();
    if (err) throw err;
  }

  count(method: Method) {
    return this.calls.filter((c) => c.method === method).length;
  }

  async createContainer(auth: IgAuth, input: CreateContainerInput) {
    this.enter("createContainer", [input]);
    const id = `container_${++this.seq}`;
    const isVideo = input.kind === "reel" || (input.kind === "carousel_item" && !!input.videoUrl);
    this.containers.set(id, { id, input, status: isVideo && this.videoPollsUntilReady > 0 ? "IN_PROGRESS" : "FINISHED", polls: 0, createdAt: this.now() });
    this.exit("createContainer");
    return { id };
  }

  async getContainerStatus(auth: IgAuth, containerId: string) {
    this.enter("getContainerStatus", [containerId]);
    const c = this.containers.get(containerId);
    if (!c) throw new InstagramApiError(`Container ${containerId} does not exist`, { code: 100, transient: false });
    if (c.status === "IN_PROGRESS" && ++c.polls >= this.videoPollsUntilReady) c.status = "FINISHED";
    return { status: c.status };
  }

  async publishContainer(auth: IgAuth, containerId: string) {
    this.enter("publishContainer", [containerId]);
    const c = this.containers.get(containerId);
    if (!c) throw new InstagramApiError(`Container ${containerId} does not exist`, { code: 100, transient: false });
    if (c.status === "PUBLISHED") throw new InstagramApiError("Container already published", { code: 9007, transient: false });
    if (c.status !== "FINISHED") throw new InstagramApiError(`Container not ready (${c.status})`, { code: 9007, transient: true });
    const mediaId = `ig_media_${++this.seq}`;
    c.status = "PUBLISHED";
    c.mediaId = mediaId;
    const caption = "caption" in c.input ? c.input.caption : undefined;
    this.media.set(mediaId, {
      id: mediaId,
      caption,
      mediaType: c.input.kind === "carousel" ? "CAROUSEL_ALBUM" : c.input.kind === "reel" ? "VIDEO" : "IMAGE",
      mediaProductType: c.input.kind === "reel" ? "REELS" : "FEED",
      permalink: `https://www.instagram.com/p/${mediaId}/`,
      timestamp: this.now(),
    });
    this.publishLimit.used++;
    this.exit("publishContainer");
    return { mediaId };
  }

  async getMedia(auth: IgAuth, mediaId: string) {
    this.enter("getMedia", [mediaId]);
    const m = this.media.get(mediaId);
    if (!m) throw new InstagramApiError(`Media ${mediaId} not found`, { code: 100, transient: false });
    return m;
  }

  async listRecentMedia(auth: IgAuth, opts: { limit: number; since?: Date }) {
    this.enter("listRecentMedia", [opts]);
    return [...this.media.values()]
      .filter((m) => !opts.since || m.timestamp >= opts.since)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, opts.limit);
  }

  async postComment(auth: IgAuth, mediaId: string, message: string) {
    this.enter("postComment", [mediaId, message]);
    this.comments.push({ mediaId, message });
    return { id: `comment_${++this.seq}` };
  }

  async getPublishingLimit() {
    this.enter("getPublishingLimit", []);
    return { ...this.publishLimit };
  }
}
