"use client";

import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventClickArg, EventContentArg, EventDropArg, EventInput, EventSourceFuncArg } from "@fullcalendar/core";
import type { DateClickArg } from "@fullcalendar/interaction";
import { AlertTriangle, Bot, Camera, ExternalLink, Globe, Plus, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useLiveChanges } from "@/components/app/live";
import { movePostAction } from "@/app/(app)/actions";
import { MISSED_AFTER_MS, MOVABLE, SOURCE_META, STATUSES, STATUS_META, TYPE_LABEL, countdown, type Source, type Status } from "@/lib/ui/meta";
import type { FeedItem } from "@/lib/services/feed";

type BrandOpt = { id: string; slug: string; name: string; color: string; timezone: string; firstSlot: string; canCreate: boolean; canSchedule: boolean };
type CalOpt = { id: string; name: string; color: string | null; brandId: string };

const DAY = 86_400_000;
const selectCls = "h-11 rounded-full border border-input bg-inset px-4 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** null on the server, then true/false once the browser knows its width. */
function useNarrow(): boolean | null {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(max-width: 767px)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(max-width: 767px)").matches,
    () => null,
  );
}

export function CalendarView({ brands, calendars, initialScope }: { brands: BrandOpt[]; calendars: CalOpt[]; initialScope: string }) {
  const router = useRouter();
  const ref = useRef<FullCalendar>(null);
  const narrow = useNarrow();
  const [scope, setScope] = useState(initialScope); // "all" | "brand:<id>" | "cal:<id>"
  const [colorBy, setColorBy] = useState<"brand" | "status">("brand");
  const [showFilters, setShowFilters] = useState(false);
  const [statusF, setStatusF] = useState<Status[]>([]);
  const [typeF, setTypeF] = useState<string[]>([]);
  const [sourceF, setSourceF] = useState<Source[]>([]);
  const [selected, setSelected] = useState<FeedItem | null>(null);
  const [, setTick] = useState(0);

  const brandById = useMemo(() => new Map(brands.map((b) => [b.id, b])), [brands]);
  const scopeBrand = scope.startsWith("brand:") ? brandById.get(scope.slice(6)) : scope.startsWith("cal:") ? brandById.get(calendars.find((c) => c.id === scope.slice(4))?.brandId ?? "") : undefined;

  // keep countdowns fresh
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // remember the chosen calendar in the URL so links and reloads keep it
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("scope", scope);
    window.history.replaceState(null, "", url);
  }, [scope]);

  const refetch = useCallback(() => ref.current?.getApi().refetchEvents(), []);
  useLiveChanges(refetch);

  const fetchEvents = useCallback(
    async (info: EventSourceFuncArg): Promise<EventInput[]> => {
      // the calendar shows brand wall-clock times as "UTC"; widen the window to cover every timezone
      const q = new URLSearchParams({ from: new Date(info.start.getTime() - DAY).toISOString(), to: new Date(info.end.getTime() + DAY).toISOString() });
      if (scope.startsWith("brand:")) q.set("brandId", scope.slice(6));
      if (scope.startsWith("cal:")) q.set("calendarId", scope.slice(4));
      const r = await fetch(`/api/ui/posts?${q}`, { cache: "no-store" });
      if (!r.ok) {
        toast.error("Couldn't load the calendar. It will retry on the next update.");
        return [];
      }
      const { items } = (await r.json()) as { items: FeedItem[] };
      return items
        .filter((p) => (!statusF.length || statusF.includes(p.status as Status)) && (!typeF.length || typeF.includes(p.type)) && (!sourceF.length || sourceF.includes(p.source as Source)))
        .map((p) => {
          const color = colorBy === "brand" ? p.brand.color : STATUS_META[p.status as Status].color;
          return {
            id: p.id,
            start: p.wall,
            allDay: false,
            editable: MOVABLE.includes(p.status as Status) && Boolean(brandById.get(p.brandId)?.canSchedule),
            backgroundColor: `${color}2e`,
            borderColor: color,
            textColor: "var(--ink)",
            extendedProps: { item: p },
          };
        });
    },
    [scope, statusF, typeF, sourceF, colorBy, brandById],
  );

  async function onDrop(arg: EventDropArg) {
    const item = arg.event.extendedProps.item as FeedItem;
    const wall = arg.event.start!.toISOString().slice(0, 16);
    const r = await movePostAction({ postId: item.id, version: item.version, wall });
    if (!r.ok) {
      arg.revert();
      toast.error(r.error);
      return;
    }
    toast.success(item.status === "scheduled" ? "Rescheduled" : "Planned time moved");
    refetch();
  }

  function onDateClick(arg: DateClickArg) {
    const brand = scopeBrand ?? (brands.length === 1 ? brands[0] : undefined);
    if (brand && !brand.canCreate) return toast.error("You can't create posts for this brand.");
    const day = arg.date.toISOString().slice(0, 10);
    const time = arg.allDay ? (brand?.firstSlot ?? "09:00") : arg.date.toISOString().slice(11, 16);
    const q = new URLSearchParams({ at: `${day}T${time}` });
    if (brand) q.set("brand", brand.id);
    if (scope.startsWith("cal:")) q.set("calendar", scope.slice(4));
    router.push(`/posts/new?${q}`);
  }

  const chip = (on: boolean) => cn("min-h-9 rounded-full border px-3 text-xs", on ? "border-primary bg-violet-soft text-foreground" : "border-input text-muted-foreground hover:text-foreground");
  const toggle = <T,>(list: T[], v: T, set: (x: T[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const filterCount = statusF.length + typeF.length + sourceF.length;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">Calendar</h1>
        <label className="sr-only" htmlFor="cal-scope">
          Calendar
        </label>
        <select id="cal-scope" value={scope} onChange={(e) => setScope(e.target.value)} className={selectCls}>
          {brands.length > 1 && <option value="all">All brands</option>}
          {brands.map((b) => (
            <optgroup key={b.id} label={b.name}>
              <option value={`brand:${b.id}`}>{b.name}: all posts</option>
              {calendars
                .filter((c) => c.brandId === b.id)
                .map((c) => (
                  <option key={c.id} value={`cal:${c.id}`}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <div role="group" aria-label="Colour by" className="glass flex rounded-full p-1">
          {(["brand", "status"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={colorBy === m} onClick={() => setColorBy(m)} className={cn("min-h-9 rounded-full px-3 text-xs capitalize", colorBy === m ? "bg-accent text-foreground" : "text-muted-foreground")}>
              {m}
            </button>
          ))}
        </div>
        <Button variant="outline" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}>
          <SlidersHorizontal aria-hidden /> Filters{filterCount ? ` (${filterCount})` : ""}
        </Button>
        {(scopeBrand ? scopeBrand.canCreate : brands.some((b) => b.canCreate)) && (
          <Button render={<Link href={`/posts/new${scopeBrand ? `?brand=${scopeBrand.id}` : ""}`} />}>
            <Plus aria-hidden /> New post
          </Button>
        )}
      </div>

      {showFilters && (
        <div className="glass grid gap-3 rounded-[22px] p-4 text-sm">
          <FilterRow label="Status">
            {STATUSES.map((s) => (
              <button key={s} type="button" className={chip(statusF.includes(s))} aria-pressed={statusF.includes(s)} onClick={() => toggle(statusF, s, setStatusF)}>
                <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full" style={{ background: STATUS_META[s].color }} />
                {STATUS_META[s].label}
              </button>
            ))}
          </FilterRow>
          <FilterRow label="Type">
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <button key={k} type="button" className={chip(typeF.includes(k))} aria-pressed={typeF.includes(k)} onClick={() => toggle(typeF, k, setTypeF)}>
                {v}
              </button>
            ))}
          </FilterRow>
          <FilterRow label="Source">
            {(Object.keys(SOURCE_META) as Source[]).map((k) => (
              <button key={k} type="button" className={chip(sourceF.includes(k))} aria-pressed={sourceF.includes(k)} onClick={() => toggle(sourceF, k, setSourceF)}>
                {SOURCE_META[k].label}
              </button>
            ))}
          </FilterRow>
        </div>
      )}

      <div className="glass planner-calendar min-h-[60vh] rounded-[22px] p-2 sm:p-4">
        {narrow === null ? (
          <div aria-busy="true" aria-label="Loading calendar" className="h-[60vh] animate-pulse rounded-[18px] bg-muted" />
        ) : (
          <FullCalendar
            // remount when the scope, colours or filters change so the event source refetches with them
            key={`${scope}|${colorBy}|${statusF.join()}|${typeF.join()}|${sourceF.join()}|${narrow}`}
            ref={ref}
            plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
            timeZone="UTC"
            initialView={narrow ? "listWeek" : "dayGridMonth"}
            headerToolbar={{ left: "prev,next today", center: "title", right: narrow ? "listWeek,dayGridMonth" : "dayGridMonth,timeGridWeek,timeGridDay,listWeek" }}
            buttonText={{ today: "Today", month: "Month", week: "Week", day: "Day", list: "List" }}
            firstDay={1}
            height="auto"
            nowIndicator
            dayMaxEvents={4}
            eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
            slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
            events={fetchEvents}
            eventContent={(arg) => <EventChip arg={arg} />}
            eventClick={(arg: EventClickArg) => {
              arg.jsEvent.preventDefault();
              setSelected(arg.event.extendedProps.item as FeedItem);
            }}
            eventDrop={onDrop}
            dateClick={onDateClick}
            noEventsText="No posts in this range."
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Times are shown in each brand&apos;s own timezone{scopeBrand ? ` (${scopeBrand.timezone})` : ""}. Drag a post to move it; click an empty day or time to plan a new one.
      </p>

      {selected && <PostPanel item={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-14 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function SourceIcon({ source, className }: { source: string; className?: string }) {
  if (source === "hermes") return <Bot className={className} aria-label="Created by Hermes" />;
  if (source === "inqi") return <Globe className={className} aria-label="Created in inqi" />;
  if (source === "instagram") return <Camera className={className} aria-label="Posted in the Instagram app" />;
  return null;
}

const isMissed = (p: FeedItem) => p.status === "scheduled" && new Date(p.at).getTime() < Date.now() - MISSED_AFTER_MS;

function EventChip({ arg }: { arg: EventContentArg }) {
  const p = arg.event.extendedProps.item as FeedItem;
  const missed = isMissed(p);
  return (
    <div className={cn("flex w-full min-w-0 items-center gap-1.5 overflow-hidden px-1 py-0.5 text-[11px] leading-tight", missed && "rounded ring-1 ring-destructive")}>
      {p.thumbnailUrl && <img src={p.thumbnailUrl} alt="" className="size-6 shrink-0 rounded object-cover" />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 font-medium">
          {arg.timeText}
          <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: STATUS_META[p.status as Status].color }} />
          <SourceIcon source={p.source} className="size-3 shrink-0" />
          {missed && <AlertTriangle className="size-3 shrink-0 text-destructive" aria-label="Missed its time" />}
        </span>
        <span className="block truncate text-muted-foreground">{p.caption || TYPE_LABEL[p.type as keyof typeof TYPE_LABEL]}</span>
      </span>
    </div>
  );
}

function PostPanel({ item: p, onClose }: { item: FeedItem; onClose: () => void }) {
  const at = new Date(p.at);
  const missed = isMissed(p);
  return (
    <aside role="dialog" aria-label="Post details" className="glass fixed inset-x-3 bottom-24 z-50 max-h-[70dvh] overflow-auto rounded-[28px] p-5 sm:inset-x-auto sm:right-6 sm:w-[380px] lg:bottom-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: p.brand.color }} /> {p.brand.name}
            <SourceIcon source={p.source} className="size-3.5" />
            <span>{SOURCE_META[p.source as Source].label}</span>
          </p>
          <p className="mt-1 font-medium">
            {STATUS_META[p.status as Status].label} · {TYPE_LABEL[p.type as keyof typeof TYPE_LABEL]}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="grid size-11 place-items-center rounded-full hover:bg-accent">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {p.thumbnailUrl && <img src={p.thumbnailUrl} alt="" className="mb-3 aspect-[4/5] w-full rounded-[18px] object-cover" />}
      <p className="text-sm">
        {p.local.slice(0, 10)} at {p.local.slice(11, 16)} <span className="text-muted-foreground">({p.brand.timezone})</span>
        {p.status === "scheduled" && !missed && <span className="ml-2 text-primary">{countdown(at)}</span>}
      </p>
      {missed && (
        <p role="alert" className="mt-2 flex items-center gap-2 rounded-[14px] bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="size-4" aria-hidden /> Missed its time. It publishes on the next run, or retry from the editor.
        </p>
      )}
      {p.status === "failed" && p.lastError && <p className="mt-2 rounded-[14px] bg-destructive/10 px-3 py-2 text-sm text-destructive">{p.lastError}</p>}
      {p.caption && <p className="mt-3 line-clamp-4 text-sm text-muted-foreground">{p.caption}</p>}
      {p.status === "published" && (
        <dl className="mt-3 grid grid-cols-5 gap-1 text-center">
          {(["reach", "likes", "comments", "saves", "shares"] as const).map((k) => (
            <div key={k} className="rounded-[12px] bg-inset px-1 py-2">
              <dt className="text-[10px] text-muted-foreground capitalize">{k}</dt>
              <dd className="text-sm font-semibold tabular-nums">{p.metrics?.[k] ?? "–"}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {p.source !== "instagram" && <Button render={<Link href={`/posts/${p.id}`} />}>Open</Button>}
        {p.permalink && (
          <Button variant="outline" render={<a href={p.permalink} target="_blank" rel="noreferrer" />}>
            <ExternalLink aria-hidden /> Instagram
          </Button>
        )}
      </div>
    </aside>
  );
}
