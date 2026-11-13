"use client";

import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { postOpAction, scheduleAction, type ActionResult } from "@/app/(app)/actions";
import { SourceIcon } from "@/components/calendar/calendar-view";
import { STATUS_META, TYPE_LABEL, type Status } from "@/lib/ui/meta";

type Card = { id: string; brandId: string; status: string; type: string; source: string; caption: string; thumbnailUrl: string | null; scheduledAtLocal: string | null; version: number };
type Perms = Record<string, { submit: boolean; approve: boolean; schedule: boolean }>;

const COLUMNS: { status: Status; hint?: string }[] = [
  { status: "idea" },
  { status: "draft" },
  { status: "awaiting_approval", hint: "Drop to submit" },
  { status: "approved", hint: "Drop to approve" },
  { status: "rejected", hint: "Drop to reject" },
  { status: "scheduled", hint: "Drop: next free slot" },
  { status: "failed" },
  { status: "published", hint: "Last 14 days" },
];

export function Board({ posts, brands, perms, brandId }: { posts: Card[]; brands: { id: string; name: string; color: string }[]; perms: Perms; brandId: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [moving, setMoving] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const brandById = new Map(brands.map((b) => [b.id, b]));

  function run(fn: () => Promise<ActionResult>, ok: string) {
    start(async () => {
      const r = await fn();
      setMoving(null);
      if (r.ok) toast.success(ok);
      else toast.error(r.error);
      router.refresh();
    });
  }

  function refuse(msg: string) {
    setMoving(null);
    toast.error(msg);
  }

  function onDragEnd(e: DragEndEvent) {
    const card = posts.find((p) => p.id === e.active.id);
    const to = e.over?.id as Status | undefined;
    if (!card || !to || to === card.status) return;
    const p = perms[card.brandId];
    setMoving(card.id);
    switch (to) {
      case "awaiting_approval":
        if (!p?.submit) return refuse("You can't submit posts for this brand.");
        return run(() => postOpAction("submit", { postId: card.id, version: card.version }), "Sent for approval");
      case "approved":
        if (!p?.approve) return refuse("You can't approve posts for this brand.");
        return run(() => postOpAction("approve", { postId: card.id }), "Approved");
      case "rejected": {
        if (!p?.approve) return refuse("You can't review posts for this brand.");
        const comment = prompt("What should change? (required to reject)");
        if (!comment?.trim()) return setMoving(null);
        return run(() => postOpAction("reject", { postId: card.id, comment }), "Rejected");
      }
      case "scheduled":
        if (!p?.schedule) return refuse("You can't schedule posts for this brand.");
        return run(() => scheduleAction({ postId: card.id, version: card.version, nextFreeSlot: true }), "Scheduled in the next free slot");
      default:
        return refuse(`Posts can't be moved to ${STATUS_META[to].label} from the board. Open the post instead.`);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">Board</h1>
        {brands.length > 1 && (
          <nav aria-label="Brand filter" className="flex flex-wrap gap-2">
            <Link href="/board" className={cn("min-h-9 rounded-full border px-3 py-2 text-xs", !brandId ? "border-primary bg-violet-soft" : "border-input text-muted-foreground")}>
              All brands
            </Link>
            {brands.map((b) => (
              <Link key={b.id} href={`/board?brand=${b.id}`} className={cn("min-h-9 rounded-full border px-3 py-2 text-xs", brandId === b.id ? "border-primary bg-violet-soft" : "border-input text-muted-foreground")}>
                {b.name}
              </Link>
            ))}
          </nav>
        )}
      </div>
      <p className="text-sm text-muted-foreground">Drag cards between columns (or focus a card and use Space, then the arrow keys). Each drop runs the real step, with the same checks as everywhere else.</p>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-4" aria-busy={pending}>
          {COLUMNS.map((col) => {
            const cards = posts.filter((p) => p.status === col.status || (col.status === "scheduled" && p.status === "publishing"));
            return (
              <Column key={col.status} status={col.status} hint={col.hint} count={cards.length}>
                {cards.map((c) => (
                  <BoardCard key={c.id} card={c} brand={brandById.get(c.brandId)} moving={moving === c.id} />
                ))}
              </Column>
            );
          })}
        </div>
      </DndContext>
    </div>
  );
}

function Column({ status, hint, count, children }: { status: Status; hint?: string; count: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section ref={setNodeRef} aria-label={`${STATUS_META[status].label}, ${count} posts`} className={cn("glass flex w-[272px] shrink-0 snap-start flex-col gap-2 rounded-[22px] p-3 transition-colors", isOver && "ring-2 ring-primary")}>
      <header className="flex items-center gap-2 px-1">
        <span aria-hidden className="size-2.5 rounded-full" style={{ background: STATUS_META[status].color }} />
        <h2 className="text-sm font-medium">{STATUS_META[status].label}</h2>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{count}</span>
      </header>
      {hint && <p className="px-1 text-[11px] text-muted-foreground">{hint}</p>}
      <div className="grid min-h-24 gap-2">{children}</div>
    </section>
  );
}

function BoardCard({ card, brand, moving }: { card: Card; brand?: { name: string; color: string }; moving: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id, disabled: ["publishing", "published"].includes(card.status) });
  return (
    <article
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cn("touch-none rounded-[16px] border border-border bg-card p-2.5 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", isDragging && "z-50 opacity-90 shadow-lg", moving && "animate-pulse")}
    >
      <div className="flex gap-2">
        {card.thumbnailUrl ? <img src={card.thumbnailUrl} alt="" className="size-12 shrink-0 rounded-[10px] object-cover" /> : <div className="size-12 shrink-0 rounded-[10px] bg-inset" />}
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="size-2 rounded-full" style={{ background: brand?.color }} />
            <span className="truncate">{brand?.name}</span>
            <SourceIcon source={card.source} className="size-3 shrink-0" />
          </p>
          <p className="line-clamp-2">{card.caption || <span className="text-muted-foreground">{TYPE_LABEL[card.type as keyof typeof TYPE_LABEL]}, no caption yet</span>}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{card.scheduledAtLocal ? card.scheduledAtLocal.slice(5, 16).replace("T", " ") : "No time"}</span>
        <Link href={`/posts/${card.id}`} onPointerDown={(e) => e.stopPropagation()} className="rounded-full px-2 py-1 text-primary hover:bg-accent">
          Open
        </Link>
      </div>
    </article>
  );
}
