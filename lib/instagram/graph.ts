import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ContainerStatus, CreateContainerInput, IgAuth, IgMedia, InstagramClient, PublishingLimit } from "./client";
import { InstagramApiError } from "./client";

/**
 * Instagram API with Instagram Login (graph.instagram.com), per the Meta docs checked 2026-11-13:
 * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 */
export const GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION ?? "v27.0";
const GRAPH = () => `https://graph.instagram.com/${GRAPH_VERSION}`;
const MEDIA_FIELDS = "id,caption,media_type,media_product_type,permalink,timestamp,media_url,thumbnail_url";
export const IG_SCOPES = ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments"];

// Meta error codes worth retrying: 1/2 unknown/service, 4/17/32/613 rate limits
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613]);

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean } };

async function graph<T>(method: "GET" | "POST", url: string, params: Record<string, string | undefined>): Promise<T> {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const body = new URLSearchParams(clean);
  let res: Response;
  try {
    res =
      method === "GET"
        ? await fetch(`${url}?${body}`, { signal: AbortSignal.timeout(30_000) })
        : await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(30_000) }); // token in the body, never the URL
  } catch (err) {
    throw new InstagramApiError(`Instagram request failed: ${err instanceof Error ? err.message : String(err)}`, { transient: true });
  }
  const json = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    const transient = Boolean(e.is_transient) || TRANSIENT_CODES.has(e.code ?? -1) || res.status >= 500 || res.status === 429;
    throw new InstagramApiError(`Instagram: ${e.message ?? `HTTP ${res.status}`}`, { code: e.code, subcode: e.error_subcode, status: res.status, transient });
  }
  return json;
}

type RawMedia = { id: string; caption?: string; media_type: IgMedia["mediaType"]; media_product_type?: IgMedia["mediaProductType"]; permalink?: string; timestamp: string; media_url?: string; thumbnail_url?: string };
const toMedia = (m: RawMedia): IgMedia => ({
  id: m.id,
  caption: m.caption,
  mediaType: m.media_type,
  mediaProductType: m.media_product_type,
  permalink: m.permalink,
  timestamp: new Date(m.timestamp),
  mediaUrl: m.media_url,
  thumbnailUrl: m.thumbnail_url,
});

export class GraphInstagramClient implements InstagramClient {
  async createContainer(auth: IgAuth, input: CreateContainerInput) {
    const p: Record<string, string | undefined> = { access_token: auth.accessToken };
    if (input.kind === "image") Object.assign(p, { image_url: input.imageUrl, caption: input.caption, alt_text: input.altText, is_ai_generated: input.isAiGenerated ? "true" : undefined });
    if (input.kind === "reel") Object.assign(p, { media_type: "REELS", video_url: input.videoUrl, caption: input.caption, cover_url: input.coverUrl, is_ai_generated: input.isAiGenerated ? "true" : undefined });
    if (input.kind === "carousel_item")
      Object.assign(p, input.videoUrl ? { media_type: "VIDEO", video_url: input.videoUrl, is_carousel_item: "true" } : { image_url: input.imageUrl, alt_text: input.altText, is_carousel_item: "true" });
    if (input.kind === "carousel") Object.assign(p, { media_type: "CAROUSEL", children: input.children.join(","), caption: input.caption, is_ai_generated: input.isAiGenerated ? "true" : undefined });
    return graph<{ id: string }>("POST", `${GRAPH()}/${auth.igUserId}/media`, p);
  }

  async getContainerStatus(auth: IgAuth, containerId: string) {
    const r = await graph<{ status_code: ContainerStatus; status?: string }>("GET", `${GRAPH()}/${containerId}`, { fields: "status_code,status", access_token: auth.accessToken });
    return { status: r.status_code, message: r.status };
  }

  async publishContainer(auth: IgAuth, containerId: string) {
    const r = await graph<{ id: string }>("POST", `${GRAPH()}/${auth.igUserId}/media_publish`, { creation_id: containerId, access_token: auth.accessToken });
    return { mediaId: r.id };
  }

  async getMedia(auth: IgAuth, mediaId: string) {
    return toMedia(await graph<RawMedia>("GET", `${GRAPH()}/${mediaId}`, { fields: MEDIA_FIELDS, access_token: auth.accessToken }));
  }

  async listRecentMedia(auth: IgAuth, opts: { limit: number; since?: Date }) {
    const r = await graph<{ data: RawMedia[] }>("GET", `${GRAPH()}/${auth.igUserId}/media`, {
      fields: MEDIA_FIELDS,
      limit: String(Math.min(opts.limit, 100)),
      since: opts.since ? String(Math.floor(opts.since.getTime() / 1000)) : undefined,
      access_token: auth.accessToken,
    });
    return r.data.map(toMedia);
  }

  async postComment(auth: IgAuth, mediaId: string, message: string) {
    return graph<{ id: string }>("POST", `${GRAPH()}/${mediaId}/comments`, { message, access_token: auth.accessToken });
  }

  async getPublishingLimit(auth: IgAuth): Promise<PublishingLimit> {
    const r = await graph<{ data: { quota_usage?: number; config?: { quota_total?: number } }[] }>("GET", `${GRAPH()}/${auth.igUserId}/content_publishing_limit`, {
      fields: "quota_usage,config",
      access_token: auth.accessToken,
    });
    return { used: r.data[0]?.quota_usage ?? 0, total: r.data[0]?.config?.quota_total ?? 100 };
  }
}

// ---------- OAuth (Business Login for Instagram) ----------

function oauthConfig() {
  const appId = process.env.INSTAGRAM_APP_ID;
  const secret = process.env.INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  if (!appId || !secret || !redirectUri) throw new Error("Instagram isn't configured: set INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET and INSTAGRAM_REDIRECT_URI.");
  return { appId, secret, redirectUri };
}

const stateKey = () => process.env.BETTER_AUTH_SECRET ?? process.env.TOKEN_ENCRYPTION_KEY ?? "";

/** Signed, expiring OAuth state binding the flow to a brand and the user who started it (CSRF protection). */
export function signState(payload: { brandId: string; userId: string }, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + 15 * 60_000, n: randomBytes(8).toString("hex") })).toString("base64url");
  const sig = createHmac("sha256", stateKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(state: string, now = Date.now()): { brandId: string; userId: string } | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", stateKey()).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const data = JSON.parse(Buffer.from(body, "base64url").toString()) as { brandId: string; userId: string; exp: number };
  return data.exp > now ? { brandId: data.brandId, userId: data.userId } : null;
}

export function authorizeUrl(state: string) {
  const { appId, redirectUri } = oauthConfig();
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, response_type: "code", scope: IG_SCOPES.join(","), state, enable_fb_login: "false", force_reauth: "true" });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

/** code → short-lived token → long-lived (≈60 day) token, plus the account's profile. */
export async function exchangeCode(code: string) {
  const { appId, secret, redirectUri } = oauthConfig();
  type Short = { access_token: string; user_id: string | number; permissions?: string | string[] };
  const short = await graph<{ data?: Short[] } & Partial<Short>>("POST", "https://api.instagram.com/oauth/access_token", {
    client_id: appId,
    client_secret: secret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code: code.replace(/#_$/, ""),
  });
  const s = (short.data?.[0] ?? short) as Short;
  const long = await graph<{ access_token: string; expires_in: number }>("GET", "https://graph.instagram.com/access_token", { grant_type: "ig_exchange_token", client_secret: secret, access_token: s.access_token });
  const me = await graph<{ user_id?: string; id: string; username: string; account_type?: string }>("GET", `${GRAPH()}/me`, { fields: "user_id,username,account_type", access_token: long.access_token });
  const perms = Array.isArray(s.permissions) ? s.permissions : String(s.permissions ?? "").split(",").filter(Boolean);
  return { accessToken: long.access_token, expiresIn: long.expires_in, igUserId: String(me.user_id ?? me.id), username: me.username, accountType: me.account_type ?? null, scopes: perms };
}

/** Extends a long-lived token by another ~60 days (allowed once it's ≥24 h old). */
export async function refreshLongLivedToken(accessToken: string) {
  return graph<{ access_token: string; expires_in: number }>("GET", "https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token", access_token: accessToken });
}
