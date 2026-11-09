import { TZDate } from "@date-fns/tz";
import type { PostingSlot } from "@/lib/schemas/brand";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Wall-clock time in `tz` → UTC Date. Month is 1-based here. */
export function zonedToUtc(tz: string, y: number, month: number, d: number, h = 0, mi = 0): Date {
  return new Date(new TZDate(y, month - 1, d, h, mi, 0, 0, tz).getTime());
}

/** UTC Date → wall-clock parts in `tz`. */
export function utcToZonedParts(date: Date, tz: string) {
  const z = new TZDate(date.getTime(), tz);
  return {
    year: z.getFullYear(),
    month: z.getMonth() + 1,
    day: z.getDate(),
    hour: z.getHours(),
    minute: z.getMinutes(),
    weekday: z.getDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-10" in the brand timezone. */
export function zonedDateKey(date: Date, tz: string): string {
  const p = utcToZonedParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** ISO string with the brand's offset, e.g. 2026-11-10T17:00:00+05:00 (handy for agents). Minute precision. */
export function toZonedIso(date: Date, tz: string): string {
  const p = utcToZonedParts(date, tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const actual = Math.floor(date.getTime() / MINUTE) * MINUTE;
  const offsetMin = Math.round((wallAsUtc - actual) / MINUTE);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** UTC bounds [start, end) of the calendar month yyyy-mm in `tz`. */
export function monthRangeUtc(tz: string, yyyyMm: string): { from: Date; to: Date } {
  const [y, m] = yyyyMm.split("-").map(Number);
  const from = zonedToUtc(tz, y, m, 1);
  const to = m === 12 ? zonedToUtc(tz, y + 1, 1, 1) : zonedToUtc(tz, y, m + 1, 1);
  return { from, to };
}

/**
 * Expand weekly posting slots (wall-clock in `tz`) into concrete UTC instants within [from, to).
 * Works day by day in the brand's timezone, so DST changes are handled by TZDate.
 */
export function expandSlots(slots: PostingSlot[], tz: string, from: Date, to: Date): Date[] {
  if (!slots.length || to <= from) return [];
  const out: Date[] = [];
  const start = utcToZonedParts(from, tz);
  let day = new TZDate(start.year, start.month - 1, start.day, 0, 0, 0, 0, tz);
  // Guard against runaway loops on huge ranges.
  for (let i = 0; i < 800 && day.getTime() < to.getTime(); i++) {
    const wd = day.getDay();
    for (const s of slots) {
      if (s.weekday !== wd) continue;
      const [h, mi] = s.time.split(":").map(Number);
      const at = new Date(new TZDate(day.getFullYear(), day.getMonth(), day.getDate(), h, mi, 0, 0, tz).getTime());
      if (at >= from && at < to) out.push(at);
    }
    day = new TZDate(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0, tz);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}
