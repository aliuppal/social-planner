/** Labels and colours shared by calendar, board, editor and approvals (client-safe, no server imports). */

export const STATUS_META = {
  idea: { label: "Idea", color: "#a3b0cf" },
  draft: { label: "Draft", color: "#6cb6ff" },
  awaiting_approval: { label: "Awaiting approval", color: "#f5b84b" },
  approved: { label: "Approved", color: "#3ddcbc" },
  rejected: { label: "Rejected", color: "#ff8fb1" },
  scheduled: { label: "Scheduled", color: "#8b7bff" },
  publishing: { label: "Publishing", color: "#c9c2ff" },
  published: { label: "Published", color: "#22c3a6" },
  failed: { label: "Failed", color: "#ff6b81" },
  cancelled: { label: "Cancelled", color: "#5b6578" },
} as const;
export type Status = keyof typeof STATUS_META;
export const STATUSES = Object.keys(STATUS_META) as Status[];

export const SOURCE_META = {
  ui: { label: "Planner" },
  hermes: { label: "Hermes (agent)" },
  inqi: { label: "inqi portal" },
  api: { label: "API" },
  instagram: { label: "Instagram app" },
} as const;
export type Source = keyof typeof SOURCE_META;

export const TYPE_LABEL = { image: "Image", carousel: "Carousel", reel: "Reel" } as const;
export type PostType = keyof typeof TYPE_LABEL;

/** Statuses that can still be moved on the calendar / edited. */
export const MOVABLE: Status[] = ["idea", "draft", "awaiting_approval", "approved", "rejected", "scheduled"];

export const MISSED_AFTER_MS = 5 * 60_000;

export function countdown(to: Date, now = new Date()): string {
  const ms = to.getTime() - now.getTime();
  if (ms <= 0) return "due now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h} h ${m % 60} min`;
  return `in ${Math.floor(h / 24)} days`;
}

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
