import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { BrandGuidelines, PostingSlot } from "@/lib/schemas/brand";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------- Enums ----------
export const userRole = pgEnum("user_role", ["owner", "manager", "client"]);
export const postStatus = pgEnum("post_status", [
  "idea",
  "draft",
  "awaiting_approval",
  "approved",
  "rejected",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "cancelled",
]);
export const postType = pgEnum("post_type", ["image", "carousel", "reel"]);
export const postSource = pgEnum("post_source", ["ui", "hermes", "inqi", "api", "instagram"]);
export const calendarKind = pgEnum("calendar_kind", ["brand", "custom"]);
export const postEventKind = pgEnum("post_event_kind", ["transition", "comment", "edit", "publish_attempt"]);
export const actorType = pgEnum("actor_type", ["user", "api_client", "system"]);
export const igAccountStatus = pgEnum("ig_account_status", ["connected", "expired", "error", "disconnected"]);
export const deliveryStatus = pgEnum("delivery_status", ["pending", "delivered", "failed"]);

// ---------- Auth (shape compatible with Better Auth core tables; wired up in phase 2) ----------
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: userRole("role").notNull().default("client"),
  externalUserId: text("external_user_id").unique(),
  disabledAt: ts("disabled_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  role: userRole("role").notNull(),
  brandIds: uuid("brand_ids").array().notNull().default(sql`'{}'::uuid[]`),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  createdAt: createdAt(),
});

// ---------- Brands ----------
export const brands = pgTable("brands", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timezone: text("timezone").notNull().default("Asia/Karachi"),
  /** expected @handle; the connected account is checked against it */
  instagramHandle: text("instagram_handle"),
  color: text("color").notNull().default("#8b7bff"),
  guidelines: jsonb("guidelines").$type<BrandGuidelines>().notNull().default({}),
  postingSlots: jsonb("posting_slots").$type<PostingSlot[]>().notNull().default([]),
  requiresApproval: boolean("requires_approval").notNull().default(true),
  clientsCanSchedule: boolean("clients_can_schedule").notNull().default(false),
  archivedAt: ts("archived_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const brandMembers = pgTable(
  "brand_members",
  {
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.brandId, t.userId] }), index("brand_members_user_idx").on(t.userId)],
);

export const instagramAccounts = pgTable("instagram_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  brandId: uuid("brand_id")
    .notNull()
    .unique()
    .references(() => brands.id, { onDelete: "cascade" }),
  igUserId: text("ig_user_id").notNull(),
  username: text("username").notNull(),
  accountType: text("account_type"),
  accessTokenEnc: text("access_token_enc").notNull(),
  tokenExpiresAt: ts("token_expires_at"),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  status: igAccountStatus("status").notNull().default("connected"),
  lastRefreshAt: ts("last_refresh_at"),
  lastError: text("last_error"),
  quotaUsed: integer("quota_used"),
  quotaTotal: integer("quota_total"),
  quotaCheckedAt: ts("quota_checked_at"),
  lastSyncedAt: ts("last_synced_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------- Calendars ----------
export const calendars = pgTable(
  "calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    kind: calendarKind("kind").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    icalTokenHash: text("ical_token_hash").unique(),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("calendars_brand_idx").on(t.brandId),
    // exactly one brand calendar per brand
    uniqueIndex("calendars_one_brand_cal").on(t.brandId).where(sql`${t.kind} = 'brand'`),
  ],
);

// ---------- API clients ----------
export const apiClients = pgTable("api_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  source: postSource("source").notNull().default("api"),
  keyPrefix: text("key_prefix").notNull().unique(),
  keyHash: text("key_hash").notNull(),
  scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
  allBrands: boolean("all_brands").notNull().default(false),
  revokedAt: ts("revoked_at"),
  lastUsedAt: ts("last_used_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const apiClientBrands = pgTable(
  "api_client_brands",
  {
    apiClientId: uuid("api_client_id")
      .notNull()
      .references(() => apiClients.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.apiClientId, t.brandId] })],
);

// ---------- Posts ----------
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    type: postType("type").notNull(),
    status: postStatus("status").notNull(),
    source: postSource("source").notNull(),
    caption: text("caption").notNull().default(""),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    firstComment: text("first_comment"),
    pillar: text("pillar"),
    notes: text("notes"),
    /** Meta's optional AI self-disclosure flag (not sent on carousel children). */
    isAiGenerated: boolean("is_ai_generated").notNull().default(false),
    scheduledAt: ts("scheduled_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByApiClientId: uuid("created_by_api_client_id").references(() => apiClients.id, {
      onDelete: "set null",
    }),
    // publishing
    queueMessageId: text("queue_message_id"),
    igContainerId: text("ig_container_id"),
    igMediaId: text("ig_media_id"),
    permalink: text("permalink"),
    thumbnailUrl: text("thumbnail_url"),
    publishedAt: ts("published_at"),
    /** failed publish attempts (drives backoff and the move to `failed`) */
    publishAttempts: integer("publish_attempts").notNull().default(0),
    /** container status checks for video while IN_PROGRESS in the current attempt */
    publishPolls: integer("publish_polls").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    lastError: text("last_error"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("posts_due_idx").on(t.status, t.scheduledAt),
    index("posts_retry_idx").on(t.status, t.nextAttemptAt),
    index("posts_brand_sched_idx").on(t.brandId, t.scheduledAt),
    index("posts_brand_published_idx").on(t.brandId, t.publishedAt),
    index("posts_brand_updated_idx").on(t.brandId, t.updatedAt),
    uniqueIndex("posts_brand_media_uq").on(t.brandId, t.igMediaId),
  ],
);

export const postMedia = pgTable(
  "post_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    url: text("url").notNull(),
    sourceUrl: text("source_url"),
    mimeType: text("mime_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: integer("size_bytes"),
    durationMs: integer("duration_ms"),
    altText: text("alt_text"),
    igChildContainerId: text("ig_child_container_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("post_media_position_uq").on(t.postId, t.position)],
);

export const calendarPosts = pgTable(
  "calendar_posts",
  {
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.calendarId, t.postId] }), index("calendar_posts_post_idx").on(t.postId)],
);

export type ActingUser = { id: string; name?: string; userId?: string };

export const postEvents = pgTable(
  "post_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    kind: postEventKind("kind").notNull(),
    fromStatus: postStatus("from_status"),
    toStatus: postStatus("to_status"),
    comment: text("comment"),
    actorType: actorType("actor_type").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorApiClientId: uuid("actor_api_client_id").references(() => apiClients.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    actingUser: jsonb("acting_user").$type<ActingUser>(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("post_events_post_idx").on(t.postId, t.createdAt)],
);

// ---------- Webhooks ----------
export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  apiClientId: uuid("api_client_id")
    .notNull()
    .references(() => apiClients.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  events: text("events").array().notNull(),
  secretEnc: text("secret_enc").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: deliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastStatusCode: integer("last_status_code"),
    nextAttemptAt: ts("next_attempt_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webhook_deliveries_pending_idx").on(t.status, t.nextAttemptAt)],
);

// ---------- Insights ----------
export const postInsights = pgTable(
  "post_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    capturedAt: ts("captured_at").notNull().defaultNow(),
    reach: integer("reach"),
    likes: integer("likes"),
    comments: integer("comments"),
    saves: integer("saves"),
    shares: integer("shares"),
    views: integer("views"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (t) => [index("post_insights_post_idx").on(t.postId, t.capturedAt)],
);

export const brandInsights = pgTable(
  "brand_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    capturedOn: date("captured_on").notNull(),
    followersCount: integer("followers_count"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex("brand_insights_day_uq").on(t.brandId, t.capturedOn)],
);

export type Brand = typeof brands.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type PostMedia = typeof postMedia.$inferSelect;
export type PostEvent = typeof postEvents.$inferSelect;
export type Calendar = typeof calendars.$inferSelect;
export type ApiClient = typeof apiClients.$inferSelect;
export type User = typeof users.$inferSelect;
export type PostStatus = (typeof postStatus.enumValues)[number];
export type PostType = (typeof postType.enumValues)[number];
export type PostSource = (typeof postSource.enumValues)[number];
export type UserRole = (typeof userRole.enumValues)[number];
