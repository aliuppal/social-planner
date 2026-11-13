"use client";

import { upload } from "@vercel/blob/client";
import { AlertTriangle, ArrowLeft, ArrowRight, Bot, CalendarClock, Check, ExternalLink, Heart, ImagePlus, Link2, MessageCircle, Send, Sparkles, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/auth/field";
import {
  addMediaUrlAction,
  addUploadedMediaAction,
  postOpAction,
  removeMediaAction,
  reorderMediaAction,
  scheduleAction,
  updatePostAction,
  type ActionResult,
} from "@/app/(app)/actions";
import { MISSED_AFTER_MS, SOURCE_META, STATUS_META, TYPE_LABEL, countdown, type Source, type Status } from "@/lib/ui/meta";
import type { BrandGuidelines } from "@/lib/schemas/brand";
import type { getPost } from "@/lib/services/posts";
import { fieldCls } from "./field-styles";

type Post = Awaited<ReturnType<typeof getPost>>;
type BrandInfo = { id: string; name: string; handle: string; color: string; timezone: string; requiresApproval: boolean; guidelines: BrandGuidelines };
type Perms = { edit: boolean; submit: boolean; approve: boolean; schedule: boolean; publish: boolean; comment: boolean };
type Act = <T>(fn: () => Promise<ActionResult<T>>, ok: string) => void;

const LOCKED: Status[] = ["publishing", "published", "cancelled"];
const CAPTION_MAX = 2200;
const normTag = (t: string) => (t.startsWith("#") ? t : `#${t}`).replace(/\s+/g, "");
const composed = (caption: string, tags: string[]) => [caption.trim(), tags.filter((t) => !caption.includes(t)).join(" ")].filter(Boolean).join("\n\n");

export function PostEditor({ post, brand, perms, grid }: { post: Post; brand: BrandInfo; perms: Perms; grid: { id: string; thumbnailUrl: string | null }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const status = post.status as Status;
  const locked = LOCKED.includes(status) || !perms.edit;

  const [type, setType] = useState(post.type);
  const [caption, setCaption] = useState(post.caption);
  const [tags, setTags] = useState<string[]>(post.hashtags);
  const [tagInput, setTagInput] = useState("");
  const [firstComment, setFirstComment] = useState(post.firstComment ?? "");
  const [pillar, setPillar] = useState(post.pillar ?? "");
  const [notes, setNotes] = useState(post.notes ?? "");
  const [ai, setAi] = useState(post.isAiGenerated);
  const [error, setError] = useState<string | null>(null);

  const contentDirty = type !== post.type || caption !== post.caption || JSON.stringify(tags) !== JSON.stringify(post.hashtags) || firstComment !== (post.firstComment ?? "");
  const dirty = contentDirty || pillar !== (post.pillar ?? "") || notes !== (post.notes ?? "") || ai !== post.isAiGenerated;
  const full = composed(caption, tags);
  const over = full.length > CAPTION_MAX;
  const tagCount = (full.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  const reapproval = contentDirty && brand.requiresApproval && (status === "approved" || status === "scheduled");

  /** Run an action, show its error, then re-render with fresh data (the editor remounts on the new version). */
  const act: Act = (fn, success) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success(success);
      router.refresh();
    });
  };

  function save() {
    act(
      () =>
        updatePostAction({
          postId: post.id,
          version: post.version,
          type: type as "image",
          caption,
          hashtags: tags,
          firstComment: firstComment || null,
          pillar: pillar || null,
          notes: notes || null,
          isAiGenerated: ai,
        }),
      reapproval ? "Saved. It needs approval again." : "Saved",
    );
  }

  function addTags(raw: string) {
    const next = raw
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(normTag)
      .filter((t) => /^#[\p{L}\p{N}_]+$/u.test(t));
    setTags((cur) => [...new Set([...cur, ...next])]);
    setTagInput("");
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="grid min-w-0 content-start gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/calendar" className="text-sm text-muted-foreground hover:text-foreground">
            ← Calendar
          </Link>
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: brand.color }} /> {brand.name}
          </span>
          <span className="rounded-full px-3 py-1 text-xs font-medium" style={{ background: `${STATUS_META[status].color}2e` }}>
            {STATUS_META[status].label}
          </span>
          {post.source !== "ui" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {post.source === "hermes" && <Bot className="size-3.5" aria-hidden />}
              {SOURCE_META[post.source as Source].label}
            </span>
          )}
          <span className="ml-auto text-xs text-muted-foreground">v{post.version}</span>
        </div>

        {error && <FormMessage>{error}</FormMessage>}
        {post.lastError && status === "failed" && (
          <p role="alert" className="flex items-start gap-2 rounded-[14px] bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> Publishing failed: {post.lastError}
          </p>
        )}

        <WorkflowBar post={post} brand={brand} perms={perms} pending={pending} act={act} />

        <section aria-labelledby="content-h" className="glass grid gap-4 rounded-[22px] p-5">
          <div className="flex items-center justify-between">
            <h2 id="content-h" className="font-medium">
              Content
            </h2>
            {!locked && (
              <Button onClick={save} disabled={!dirty || pending || over}>
                {pending ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
          {!locked && reapproval && <p className="rounded-[14px] bg-warning/15 px-3.5 py-2 text-sm">Saving caption or media changes sends this post back for approval.</p>}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="type">Type</Label>
              <select id="type" value={type} disabled={locked} onChange={(e) => setType(e.target.value as Post["type"])} className={`${fieldCls} h-11`}>
                {Object.entries(TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pillar">Pillar</Label>
              <select id="pillar" value={pillar} disabled={locked} onChange={(e) => setPillar(e.target.value)} className={`${fieldCls} h-11`}>
                <option value="">None</option>
                {(brand.guidelines.pillars ?? []).map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                {pillar && !(brand.guidelines.pillars ?? []).includes(pillar) && <option value={pillar}>{pillar}</option>}
              </select>
            </div>
            <label className="flex min-h-11 items-center gap-2 self-end text-sm">
              <input type="checkbox" checked={ai} disabled={locked} onChange={(e) => setAi(e.target.checked)} className="size-4 accent-[var(--acc)]" />
              <Sparkles className="size-4 text-muted-foreground" aria-hidden /> AI-generated label
            </label>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="caption">Caption</Label>
              <span className={cn("text-xs tabular-nums", over ? "font-semibold text-destructive" : "text-muted-foreground")} aria-live="polite">
                {full.length} / {CAPTION_MAX} with hashtags
              </span>
            </div>
            <textarea id="caption" rows={7} value={caption} disabled={locked} onChange={(e) => setCaption(e.target.value)} className={`${fieldCls} py-2.5 leading-relaxed`} />
            {brand.guidelines.defaultCta && !locked && !caption.includes(brand.guidelines.defaultCta) && (
              <button type="button" className="justify-self-start text-sm text-primary hover:underline" onClick={() => setCaption((c) => `${c.trim()}\n\n${brand.guidelines.defaultCta}`.trim())}>
                + Add the brand CTA: “{brand.guidelines.defaultCta}”
              </button>
            )}
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="tag-input">Hashtags</Label>
              <span className={cn("text-xs tabular-nums", tagCount > 30 ? "font-semibold text-destructive" : "text-muted-foreground")}>{tagCount} / 30</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <span key={t} className="flex items-center gap-1 rounded-full bg-violet-soft py-1 pr-1 pl-3 text-sm">
                  {t}
                  {!locked && (
                    <button type="button" aria-label={`Remove ${t}`} onClick={() => setTags((cur) => cur.filter((x) => x !== t))} className="grid size-7 place-items-center rounded-full hover:bg-accent">
                      <X className="size-3" aria-hidden />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {!locked && (
              <>
                <input
                  id="tag-input"
                  value={tagInput}
                  placeholder="Type tags and press Enter"
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTags(tagInput);
                    }
                  }}
                  onBlur={() => tagInput && addTags(tagInput)}
                  className={`${fieldCls} h-11`}
                />
                {Object.keys(brand.guidelines.hashtagSets ?? {}).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(brand.guidelines.hashtagSets ?? {}).map(([name, set]) => (
                      <button key={name} type="button" onClick={() => addTags(set.join(" "))} className="min-h-9 rounded-full border border-input px-3 text-xs text-muted-foreground hover:text-foreground">
                        + {name} ({set.length})
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="first-comment">First comment (optional)</Label>
              <textarea id="first-comment" rows={3} value={firstComment} disabled={locked} onChange={(e) => setFirstComment(e.target.value)} className={`${fieldCls} py-2.5`} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="notes">Internal notes</Label>
              <textarea id="notes" rows={3} value={notes} disabled={locked} onChange={(e) => setNotes(e.target.value)} className={`${fieldCls} py-2.5`} />
            </div>
          </div>
        </section>

        <MediaPanel post={post} locked={locked} pending={pending} act={act} />

        {post.publishReadiness.length > 0 && !LOCKED.includes(status) && (
          <section aria-labelledby="ready-h" className="glass rounded-[22px] p-5">
            <h2 id="ready-h" className="mb-2 flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4 text-warning" aria-hidden /> Before this can go to Instagram
            </h2>
            <ul className="grid gap-1 text-sm text-muted-foreground">
              {post.publishReadiness.map((i, n) => (
                <li key={n}>• {i.message}</li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="grid content-start gap-5">
        <Preview post={post} brand={brand} caption={full} grid={grid} />
        <AuditLog post={post} timezone={brand.timezone} canComment={perms.comment} pending={pending} act={act} />
      </div>
    </div>
  );
}

// ---------- workflow ----------

function WorkflowBar({ post, brand, perms, pending, act }: { post: Post; brand: BrandInfo; perms: Perms; pending: boolean; act: Act }) {
  const status = post.status as Status;
  const [local, setLocal] = useState(post.scheduledAtLocal?.slice(0, 16) ?? "");
  const [comment, setComment] = useState("");
  const [now] = useState(() => Date.now());
  const at = post.scheduledAt ? new Date(post.scheduledAt) : null;
  const missed = status === "scheduled" && at !== null && at.getTime() < now - MISSED_AFTER_MS;
  const canScheduleNow = perms.schedule && (status === "approved" || status === "scheduled" || status === "failed" || (status === "draft" && !brand.requiresApproval));

  return (
    <section aria-label="Workflow" className="glass grid gap-4 rounded-[22px] p-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
        {post.publishedAt ? (
          <span>
            Published {post.publishedAt.slice(0, 16).replace("T", " ")} UTC
            {post.permalink && (
              <a href={post.permalink} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-primary hover:underline">
                View on Instagram <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
          </span>
        ) : at ? (
          <span>
            {status === "scheduled" ? "Scheduled for" : "Planned for"} {post.scheduledAtLocal?.slice(0, 16).replace("T", " ")} <span className="text-muted-foreground">({brand.timezone})</span>
            {status === "scheduled" && !missed && <span className="ml-2 text-primary">{countdown(at, new Date(now))}</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">No time set yet.</span>
        )}
      </div>
      {missed && (
        <p role="alert" className="rounded-[14px] bg-destructive/10 px-3.5 py-2 text-sm text-destructive">
          This post missed its time. It goes out on the next publishing run; you can also publish it now.
        </p>
      )}

      {canScheduleNow && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="when">Time ({brand.timezone})</Label>
            <input id="when" type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} className={`${fieldCls} h-11 w-auto`} />
          </div>
          <Button disabled={pending || !local} onClick={() => act(() => scheduleAction({ postId: post.id, version: post.version, local }), status === "scheduled" ? "Rescheduled" : "Scheduled")}>
            <CalendarClock aria-hidden /> {status === "scheduled" ? "Reschedule" : "Schedule"}
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => act(() => scheduleAction({ postId: post.id, version: post.version, nextFreeSlot: true }), "Scheduled in the next free slot")}>
            Next free slot
          </Button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {perms.submit && ["idea", "draft", "rejected"].includes(status) && (
          <Button disabled={pending} onClick={() => act(() => postOpAction("submit", { postId: post.id, version: post.version }), "Sent for approval")}>
            <Send aria-hidden /> Submit for approval
          </Button>
        )}
        {perms.publish && ["approved", "scheduled"].includes(status) && (
          <Button variant="outline" disabled={pending} onClick={() => confirm("Publish this post to Instagram now?") && act(() => postOpAction("publishNow", { postId: post.id, version: post.version }), "Publishing started")}>
            Publish now
          </Button>
        )}
        {perms.publish && status === "failed" && (
          <Button disabled={pending} onClick={() => act(() => postOpAction("retry", { postId: post.id }), "Retrying now")}>
            Retry
          </Button>
        )}
        {perms.schedule && !LOCKED.includes(status) && (
          <Button variant="ghost" disabled={pending} onClick={() => confirm("Cancel this post?") && act(() => postOpAction("cancel", { postId: post.id, version: post.version }), "Cancelled")}>
            Cancel post
          </Button>
        )}
      </div>

      {perms.approve && status === "awaiting_approval" && (
        <div className="grid gap-2 rounded-[18px] bg-inset p-4">
          <Label htmlFor="review">Review comment</Label>
          <textarea id="review" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Required when rejecting" className={`${fieldCls} py-2.5`} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending} onClick={() => act(() => postOpAction("approve", { postId: post.id, comment: comment || undefined }), "Approved")}>
              <Check aria-hidden /> Approve
            </Button>
            <Button variant="destructive" disabled={pending || !comment.trim()} onClick={() => act(() => postOpAction("reject", { postId: post.id, comment }), "Rejected")}>
              <X aria-hidden /> Reject
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- media ----------

function MediaPanel({ post, locked, pending, act }: { post: Post; locked: boolean; pending: boolean; act: Act }) {
  const media = post.media ?? [];
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function move(i: number, d: -1 | 1) {
    const ids = media.map((m) => m.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    act(() => reorderMediaAction({ postId: post.id, mediaIds: ids }), "Order saved");
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      setUploading(f.name);
      try {
        const blob = await upload(`uploads/${post.id}/${f.name}`, f, { access: "public", handleUploadUrl: "/api/media/upload", clientPayload: post.id });
        const r = await addUploadedMediaAction({ postId: post.id, blobUrl: blob.url, altText: alt || undefined });
        if (r.ok) toast.success(`Added ${f.name}`);
        else toast.error(r.error);
      } catch (err) {
        toast.error(`Upload failed: ${err instanceof Error ? err.message : "unknown error"}. You can also add media by URL.`);
      }
    }
    setUploading(null);
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  return (
    <section aria-labelledby="media-h" className="glass grid gap-4 rounded-[22px] p-5">
      <h2 id="media-h" className="font-medium">
        Media <span className="text-sm font-normal text-muted-foreground">({media.length})</span>
      </h2>
      {media.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {media.map((m, i) => (
            <li key={m.id} className="grid gap-1.5">
              <div className="relative overflow-hidden rounded-[16px] bg-inset">
                {m.mimeType.startsWith("video/") ? <video src={m.url} className="aspect-[4/5] w-full object-cover" muted playsInline /> : <img src={m.url} alt={m.altText ?? ""} className="aspect-[4/5] w-full object-cover" />}
                <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">{i + 1}</span>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {m.width && m.height ? `${m.width}×${m.height}` : m.mimeType}
                {m.sizeBytes ? ` · ${(m.sizeBytes / 1048576).toFixed(1)} MB` : ""}
              </p>
              {!locked && (
                <div className="flex gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label="Move earlier" disabled={i === 0 || pending} onClick={() => move(i, -1)}>
                    <ArrowLeft aria-hidden />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Move later" disabled={i === media.length - 1 || pending} onClick={() => move(i, 1)}>
                    <ArrowRight aria-hidden />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Remove media" disabled={pending} onClick={() => act(() => removeMediaAction({ postId: post.id, mediaId: m.id }), "Removed")}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="grid place-items-center gap-2 rounded-[18px] border border-dashed border-input py-10 text-sm text-muted-foreground">
          <ImagePlus className="size-6" aria-hidden />
          No media yet. Images are converted to JPEG for Instagram.
        </p>
      )}
      {!locked && (
        <div className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <input aria-label="Alt text for the next item (optional)" placeholder="Alt text for the next item (optional)" value={alt} onChange={(e) => setAlt(e.target.value)} className={`${fieldCls} h-11`} />
            <div className="flex gap-2">
              <input aria-label="Media URL" placeholder="https://… image or video URL" value={url} onChange={(e) => setUrl(e.target.value)} className={`${fieldCls} h-11`} />
              <Button
                variant="outline"
                disabled={!url || pending}
                onClick={() => {
                  act(() => addMediaUrlAction({ postId: post.id, url, altText: alt || undefined }), "Media added");
                  setUrl("");
                  setAlt("");
                }}
              >
                <Link2 aria-hidden /> Add
              </Button>
            </div>
          </div>
          <div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            <Button variant="secondary" disabled={Boolean(uploading)} onClick={() => fileRef.current?.click()}>
              <Upload aria-hidden /> {uploading ? `Uploading ${uploading}…` : "Upload files"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- preview ----------

function Preview({ post, brand, caption, grid }: { post: Post; brand: BrandInfo; caption: string; grid: { id: string; thumbnailUrl: string | null }[] }) {
  const [tab, setTab] = useState<"feed" | "grid">("feed");
  const [slide, setSlide] = useState(0);
  const [more, setMore] = useState(false);
  const media = post.media ?? [];
  const current = media[Math.min(slide, Math.max(media.length - 1, 0))];
  const short = caption.length > 125 && !more ? `${caption.slice(0, 125)}…` : caption;
  const parts = useMemo(() => short.split(/(#[\p{L}\p{N}_]+|@[\w.]+)/gu), [short]);
  const handle = brand.handle.replace(/^@/, "");

  return (
    <section aria-labelledby="preview-h" className="glass rounded-[22px] p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="preview-h" className="font-medium">
          Preview
        </h2>
        <div role="tablist" aria-label="Preview type" className="flex rounded-full bg-inset p-1">
          {(["feed", "grid"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={cn("min-h-9 rounded-full px-3 text-xs capitalize", tab === t ? "bg-accent text-foreground" : "text-muted-foreground")}>
              {t}
            </button>
          ))}
        </div>
      </div>
      {tab === "feed" ? (
        <div className="overflow-hidden rounded-[18px] bg-white text-[#0f172a]">
          <div className="flex items-center gap-2 px-3 py-2.5">
            <span className="size-8 rounded-full" style={{ background: brand.color }} />
            <span className="text-sm font-semibold">{handle}</span>
          </div>
          <div className="relative aspect-[4/5] bg-slate-100">
            {current ? (
              current.mimeType.startsWith("video/") ? (
                <video src={current.url} className="h-full w-full object-cover" muted playsInline controls />
              ) : (
                <img src={current.url} alt={current.altText ?? ""} className="h-full w-full object-cover" />
              )
            ) : (
              <div className="grid h-full place-items-center text-sm text-slate-500">No media</div>
            )}
            {media.length > 1 && (
              <>
                <button type="button" aria-label="Previous slide" disabled={slide === 0} onClick={() => setSlide((s) => s - 1)} className="absolute top-1/2 left-2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-white/80 disabled:opacity-0">
                  <ArrowLeft className="size-4" aria-hidden />
                </button>
                <button type="button" aria-label="Next slide" disabled={slide >= media.length - 1} onClick={() => setSlide((s) => s + 1)} className="absolute top-1/2 right-2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-white/80 disabled:opacity-0">
                  <ArrowRight className="size-4" aria-hidden />
                </button>
                <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white">
                  {slide + 1}/{media.length}
                </span>
              </>
            )}
          </div>
          <div className="flex gap-3 px-3 pt-2.5">
            <Heart className="size-5" aria-hidden />
            <MessageCircle className="size-5" aria-hidden />
            <Send className="size-5" aria-hidden />
          </div>
          <p className="px-3 pt-1.5 pb-3 text-sm whitespace-pre-line">
            <span className="font-semibold">{handle} </span>
            {parts.map((p, i) => (/^[#@]/.test(p) ? <span key={i} className="text-[#00376b]">{p}</span> : <span key={i}>{p}</span>))}
            {caption.length > 125 && (
              <button type="button" className="ml-1 text-slate-500" onClick={() => setMore((m) => !m)}>
                {more ? "less" : "more"}
              </button>
            )}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-0.5 overflow-hidden rounded-[14px]">
          {[{ id: "this", thumbnailUrl: media[0]?.url ?? null }, ...grid].slice(0, 9).map((g, i) => (
            <div key={g.id} className={cn("relative aspect-[4/5] bg-inset", i === 0 && "ring-2 ring-primary ring-inset")}>
              {g.thumbnailUrl && <img src={g.thumbnailUrl} alt="" className="h-full w-full object-cover" />}
              {i === 0 && <span className="absolute bottom-1 left-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">this post</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- audit log ----------

function AuditLog({ post, timezone, canComment, pending, act }: { post: Post; timezone: string; canComment: boolean; pending: boolean; act: Act }) {
  const [comment, setComment] = useState("");
  const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const describe = (e: Post["events"][number]) => {
    if (e.kind === "transition") return e.from ? `${STATUS_META[e.from as Status].label} → ${STATUS_META[e.to as Status].label}` : `Created as ${STATUS_META[e.to as Status].label.toLowerCase()}`;
    if (e.kind === "edit") return `Edited ${((e.meta?.fields as string[] | undefined) ?? [String(e.meta?.action ?? "")]).join(", ").replace(/_/g, " ")}`;
    if (e.kind === "publish_attempt") return "Publishing";
    return "Comment";
  };
  return (
    <section aria-labelledby="audit-h" className="glass rounded-[22px] p-4">
      <h2 id="audit-h" className="mb-3 font-medium">
        Activity
      </h2>
      <ol className="grid max-h-[480px] gap-3 overflow-auto pr-1">
        {[...post.events].reverse().map((e, i) => (
          <li key={i} className="border-l-2 border-border pl-3 text-sm">
            <p>
              <span className="font-medium">{describe(e)}</span> <span className="text-muted-foreground">by {e.actor}</span>
            </p>
            {e.comment && <p className="mt-0.5 text-muted-foreground">“{e.comment}”</p>}
            <p className="text-xs text-muted-foreground">{fmt(e.at)}</p>
          </li>
        ))}
      </ol>
      {canComment && (
        <div className="mt-3 flex gap-2">
          <input aria-label="Add a comment" placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} className={`${fieldCls} h-11`} />
          <Button
            variant="outline"
            disabled={!comment.trim() || pending}
            onClick={() => {
              act(() => postOpAction("comment", { postId: post.id, comment }), "Comment added");
              setComment("");
            }}
          >
            Post
          </Button>
        </div>
      )}
    </section>
  );
}
