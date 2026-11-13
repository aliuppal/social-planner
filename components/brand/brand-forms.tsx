"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FormMessage } from "@/components/auth/field";
import { fieldCls } from "@/components/post/field-styles";
import { createBrandAction, createCalendarAction, updateBrandAction, updateCalendarAction, updateGuidelinesAction, type ActionResult } from "@/app/(app)/actions";
import type { BrandGuidelines, PostingSlot } from "@/lib/schemas/brand";
import { WEEKDAYS } from "@/lib/ui/meta";

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function act<T>(fn: () => Promise<ActionResult<T>>, ok: string, then?: (data: T) => void) {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(ok);
      if (then) then(r.data);
      else router.refresh();
    });
  }
  return { pending, error, act };
}

function useTimezones() {
  return useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return ["Asia/Karachi", "UTC"];
    }
  }, []);
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="glass grid content-start gap-4 rounded-[22px] p-5">
      <h2 id={id} className="font-medium">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ---------- create ----------

export function NewBrandForm() {
  const router = useRouter();
  const { pending, error, act } = useAct();
  const tzs = useTimezones();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const autoSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return (
    <form
      className="glass grid gap-4 rounded-[22px] p-5 sm:p-6"
      action={(f) =>
        act(
          () =>
            createBrandAction({
              name,
              slug: slugTouched ? slug : autoSlug,
              instagramHandle: String(f.get("handle") || "") || undefined,
              timezone: String(f.get("timezone")),
              color: String(f.get("color")),
              requiresApproval: f.get("requiresApproval") === "on",
            }),
          "Brand created",
          (b) => router.push(`/brands/${b.slug}`),
        )
      }
    >
      {error && <FormMessage>{error}</FormMessage>}
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <input id="name" required value={name} onChange={(e) => setName(e.target.value)} className={`${fieldCls} h-11`} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="slug">Slug (used by agents, e.g. uppal-nq1)</Label>
        <input
          id="slug"
          required
          value={slugTouched ? slug : autoSlug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          className={`${fieldCls} h-11`}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="handle">Instagram handle</Label>
          <input id="handle" name="handle" placeholder="@brand" className={`${fieldCls} h-11`} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="color">Colour</Label>
          <input id="color" name="color" type="color" defaultValue="#8b7bff" className="h-11 w-full cursor-pointer rounded-[14px] border border-input bg-inset" />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="timezone">Timezone</Label>
        <select id="timezone" name="timezone" defaultValue="Asia/Karachi" className={`${fieldCls} h-11`}>
          {tzs.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" name="requiresApproval" defaultChecked className="size-4 accent-[var(--acc)]" /> Posts need approval before scheduling
      </label>
      <div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Creating…" : "Create brand"}
        </Button>
      </div>
    </form>
  );
}

// ---------- settings ----------

type BrandView = { id: string; name: string; slug: string; timezone: string; instagramHandle: string | null; color: string; requiresApproval: boolean; clientsCanSchedule: boolean };

export function BrandSettingsForm({ brand, canWrite }: { brand: BrandView; canWrite: boolean }) {
  const { pending, error, act } = useAct();
  const tzs = useTimezones();
  return (
    <Section id="settings-h" title="Settings">
      <form
        className="grid gap-4"
        action={(f) =>
          act(
            () =>
              updateBrandAction({
                brandId: brand.id,
                name: String(f.get("name")),
                ...(String(f.get("handle") || "") ? { instagramHandle: String(f.get("handle")) } : {}),
                timezone: String(f.get("timezone")),
                color: String(f.get("color")),
                requiresApproval: f.get("requiresApproval") === "on",
                clientsCanSchedule: f.get("clientsCanSchedule") === "on",
              }),
            "Settings saved",
          )
        }
      >
        {error && <FormMessage>{error}</FormMessage>}
        <fieldset disabled={!canWrite || pending} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="b-name">Name</Label>
              <input id="b-name" name="name" defaultValue={brand.name} required className={`${fieldCls} h-11`} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="b-handle">Instagram handle</Label>
              <input id="b-handle" name="handle" defaultValue={brand.instagramHandle ?? ""} placeholder="@brand" className={`${fieldCls} h-11`} />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <div className="grid gap-2">
              <Label htmlFor="b-tz">Timezone</Label>
              <select id="b-tz" name="timezone" defaultValue={brand.timezone} className={`${fieldCls} h-11`}>
                {tzs.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="b-color">Colour</Label>
              <input id="b-color" name="color" type="color" defaultValue={brand.color} className="h-11 w-full cursor-pointer rounded-[14px] border border-input bg-inset" />
            </div>
          </div>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" name="requiresApproval" defaultChecked={brand.requiresApproval} className="size-4 accent-[var(--acc)]" /> Posts need approval before scheduling
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" name="clientsCanSchedule" defaultChecked={brand.clientsCanSchedule} className="size-4 accent-[var(--acc)]" /> Clients can create and schedule posts
          </label>
          <p className="text-xs text-muted-foreground">Slug for agents: {brand.slug}</p>
          {canWrite && (
            <div>
              <Button type="submit">{pending ? "Saving…" : "Save settings"}</Button>
            </div>
          )}
        </fieldset>
      </form>
    </Section>
  );
}

// ---------- posting slots ----------

export function SlotsEditor({ brandId, timezone, slots, canWrite }: { brandId: string; timezone: string; slots: PostingSlot[]; canWrite: boolean }) {
  const { pending, error, act } = useAct();
  // grouped by time: [{ time: "17:00", days: [0..6] }]
  const [rows, setRows] = useState(() => {
    const m = new Map<string, Set<number>>();
    for (const s of slots) m.set(s.time, (m.get(s.time) ?? new Set()).add(s.weekday));
    return [...m.entries()].sort().map(([time, days]) => ({ time, days: [...days] }));
  });
  const toggleDay = (i: number, d: number) => setRows((r) => r.map((row, j) => (j === i ? { ...row, days: row.days.includes(d) ? row.days.filter((x) => x !== d) : [...row.days, d] } : row)));
  const save = () => act(() => updateBrandAction({ brandId, postingSlots: rows.flatMap((r) => r.days.map((weekday) => ({ weekday, time: r.time }))) }), "Posting slots saved");

  return (
    <Section id="slots-h" title={`Posting slots (${timezone})`}>
      {error && <FormMessage>{error}</FormMessage>}
      <p className="text-sm text-muted-foreground">“Next free slot” scheduling picks the earliest of these that isn&apos;t taken.</p>
      <ul className="grid gap-3">
        {rows.map((row, i) => (
          <li key={i} className="grid gap-2 rounded-[18px] bg-inset p-3">
            <div className="flex items-center gap-2">
              <label htmlFor={`slot-${i}`} className="sr-only">
                Time
              </label>
              <input
                id={`slot-${i}`}
                type="time"
                value={row.time}
                disabled={!canWrite}
                onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))}
                className={`${fieldCls} h-11 w-36`}
              />
              {canWrite && (
                <Button variant="ghost" size="icon" aria-label="Remove this time" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden />
                </Button>
              )}
            </div>
            <div role="group" aria-label={`Days for ${row.time}`} className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d, n) => (
                <button
                  key={d}
                  type="button"
                  disabled={!canWrite}
                  aria-pressed={row.days.includes(n)}
                  onClick={() => toggleDay(i, n)}
                  className={cn("min-h-10 min-w-12 rounded-full border text-xs", row.days.includes(n) ? "border-primary bg-violet-soft" : "border-input text-muted-foreground")}
                >
                  {d}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setRows((r) => [...r, { time: "12:00", days: [1, 2, 3, 4, 5] }])}>
            <Plus aria-hidden /> Add time
          </Button>
          <Button disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save slots"}
          </Button>
        </div>
      )}
    </Section>
  );
}

// ---------- guidelines ----------

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

export function GuidelinesForm({ brandId, guidelines: g, canWrite }: { brandId: string; guidelines: BrandGuidelines; canWrite: boolean }) {
  const { pending, error, act } = useAct();
  const setsText = Object.entries(g.hashtagSets ?? {})
    .map(([k, v]) => `${k}: ${v.join(" ")}`)
    .join("\n");

  function submit(f: FormData) {
    const hashtagSets: Record<string, string[]> = {};
    for (const line of lines(String(f.get("hashtagSets") ?? ""))) {
      const [name, ...rest] = line.split(":");
      const tags = rest
        .join(":")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((t) => (t.startsWith("#") ? t : `#${t}`));
      if (name.trim() && tags.length) hashtagSets[name.trim()] = tags;
    }
    const opt = (k: string) => String(f.get(k) ?? "").trim() || undefined;
    const list = (k: string) => {
      const l = lines(String(f.get(k) ?? ""));
      return l.length ? l : undefined;
    };
    act(
      () =>
        updateGuidelinesAction({
          brandId,
          mode: "replace",
          guidelines: {
            focus: opt("focus"),
            voice: opt("voice"),
            visualStyle: opt("visualStyle"),
            defaultCta: opt("defaultCta"),
            pillars: list("pillars"),
            dos: list("dos"),
            donts: list("donts"),
            fonts: list("fonts"),
            palette: list("palette"),
            hashtagSets: Object.keys(hashtagSets).length ? hashtagSets : undefined,
          },
        }),
      "Guidelines saved",
    );
  }

  const area = (name: string, label: string, value: string | undefined, rows = 3, hint?: string) => (
    <div className="grid gap-2">
      <Label htmlFor={`g-${name}`}>{label}</Label>
      <textarea id={`g-${name}`} name={name} rows={rows} defaultValue={value ?? ""} className={`${fieldCls} py-2.5`} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );

  return (
    <Section id="guide-h" title="Guidelines (Hermes reads these before writing)">
      <form action={submit} className="grid gap-4">
        {error && <FormMessage>{error}</FormMessage>}
        <fieldset disabled={!canWrite || pending} className="grid gap-4 lg:grid-cols-2">
          {area("focus", "Focus", g.focus)}
          {area("voice", "Voice", g.voice)}
          {area("visualStyle", "Visual style", g.visualStyle)}
          <div className="grid gap-2">
            <Label htmlFor="g-defaultCta">Default call to action</Label>
            <input id="g-defaultCta" name="defaultCta" defaultValue={g.defaultCta ?? ""} className={`${fieldCls} h-11`} />
          </div>
          {area("pillars", "Content pillars", g.pillars?.join("\n"), 4, "One per line")}
          {area("hashtagSets", "Hashtag sets", setsText, 4, "One set per line: name: #tag #tag")}
          {area("dos", "Do", g.dos?.join("\n"), 4, "One rule per line")}
          {area("donts", "Don't", g.donts?.join("\n"), 4, "One rule per line")}
          {area("palette", "Colour palette", g.palette?.join("\n"), 3, "Hex colours, one per line (#8b7bff)")}
          {area("fonts", "Fonts", g.fonts?.join("\n"), 3, "One per line")}
        </fieldset>
        {canWrite && (
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save guidelines"}
            </Button>
          </div>
        )}
      </form>
    </Section>
  );
}

// ---------- custom calendars ----------

type Cal = { id: string; name: string; color: string | null; startsOn: string | null; endsOn: string | null; archived: boolean };

export function CalendarsManager({ brandId, calendars, canWrite }: { brandId: string; calendars: Cal[]; canWrite: boolean }) {
  const { pending, error, act } = useAct();
  return (
    <Section id="cals-h" title="Custom calendars">
      <p className="text-sm text-muted-foreground">Campaigns, series or client plans. Every post is on the brand calendar already; tag posts onto these as well. Private iCal links arrive in phase 6.</p>
      {error && <FormMessage>{error}</FormMessage>}
      {calendars.length > 0 && (
        <ul className="grid gap-2">
          {calendars.map((c) => (
            <li key={c.id} className={cn("flex flex-wrap items-center gap-3 rounded-[18px] bg-inset p-3", c.archived && "opacity-60")}>
              <span aria-hidden className="size-3 rounded-full" style={{ background: c.color ?? "var(--acc)" }} />
              <span className="font-medium">{c.name}</span>
              <span className="text-sm text-muted-foreground">{c.startsOn ? `${c.startsOn} → ${c.endsOn ?? "…"}` : "No dates"}</span>
              {canWrite && (
                <span className="ml-auto flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      const name = prompt("Rename calendar", c.name);
                      if (name?.trim() && name !== c.name) act(() => updateCalendarAction({ calendarId: c.id, name: name.trim() }), "Renamed");
                    }}
                  >
                    Rename
                  </Button>
                  <Button variant="ghost" size="sm" disabled={pending} onClick={() => act(() => updateCalendarAction({ calendarId: c.id, archived: !c.archived }), c.archived ? "Restored" : "Archived")}>
                    {c.archived ? "Restore" : "Archive"}
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form
          className="grid gap-3 sm:grid-cols-[1fr_80px_150px_150px_auto] sm:items-end"
          action={(f) =>
            act(
              () =>
                createCalendarAction({
                  brandId,
                  name: String(f.get("name")),
                  color: String(f.get("color")),
                  startsOn: String(f.get("startsOn") || "") || undefined,
                  endsOn: String(f.get("endsOn") || "") || undefined,
                }),
              "Calendar created",
            )
          }
        >
          <div className="grid gap-1.5">
            <Label htmlFor="c-name">New calendar</Label>
            <input id="c-name" name="name" required placeholder="Ramadan 2027" className={`${fieldCls} h-11`} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="c-color">Colour</Label>
            <input id="c-color" name="color" type="color" defaultValue="#3ddcbc" className="h-11 w-full cursor-pointer rounded-[14px] border border-input bg-inset" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="c-start">Starts</Label>
            <input id="c-start" name="startsOn" type="date" className={`${fieldCls} h-11`} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="c-end">Ends</Label>
            <input id="c-end" name="endsOn" type="date" className={`${fieldCls} h-11`} />
          </div>
          <Button type="submit" disabled={pending}>
            <Plus aria-hidden /> Create
          </Button>
        </form>
      )}
    </Section>
  );
}
