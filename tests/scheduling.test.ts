import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandSlots, monthRangeUtc, toZonedIso, utcToZonedParts, zonedDateKey, zonedToUtc } from "@/lib/time";
import type { Actor } from "@/lib/auth/guard";
import { createPost, schedulePost, submitForApproval, approvePost, reschedulePost } from "@/lib/services/posts";
import { getFreeSlots } from "@/lib/services/scheduling";
import { getCalendar } from "@/lib/services/calendars";
import { IMG, KARACHI_17, makeBrand, makeUser, setupEnv, type TestEnv } from "./helpers";

const KHI = "Asia/Karachi";

describe("UTC ↔ Asia/Karachi", () => {
  it("17:00 in Karachi is 12:00 UTC (UTC+5, no DST)", () => {
    expect(zonedToUtc(KHI, 2026, 11, 10, 17, 0).toISOString()).toBe("2026-11-10T12:00:00.000Z");
    expect(zonedToUtc(KHI, 2026, 6, 10, 17, 0).toISOString()).toBe("2026-06-10T12:00:00.000Z");
  });

  it("converts UTC back to Karachi wall-clock and date, across midnight", () => {
    const d = new Date("2026-11-10T20:30:00Z"); // 01:30 next day in Karachi
    expect(utcToZonedParts(d, KHI)).toMatchObject({ year: 2026, month: 11, day: 11, hour: 1, minute: 30 });
    expect(zonedDateKey(d, KHI)).toBe("2026-11-11");
    expect(toZonedIso(d, KHI)).toBe("2026-11-11T01:30:00+05:00");
  });

  it("month ranges start at local midnight", () => {
    const { from, to } = monthRangeUtc(KHI, "2026-12");
    expect(from.toISOString()).toBe("2026-11-30T19:00:00.000Z");
    expect(to.toISOString()).toBe("2026-12-31T19:00:00.000Z");
  });

  it("expands daily 17:00 slots into UTC instants", () => {
    const slots = expandSlots(KARACHI_17, KHI, new Date("2026-11-10T00:00:00Z"), new Date("2026-11-13T00:00:00Z"));
    expect(slots.map((s) => s.toISOString())).toEqual(["2026-11-10T12:00:00.000Z", "2026-11-11T12:00:00.000Z", "2026-11-12T12:00:00.000Z"]);
  });

  it("keeps wall-clock slots correct across a DST change (New York)", () => {
    // DST ends 2026-11-01 in New York: 09:00 local is 13:00Z before, 14:00Z after
    const slots = expandSlots([{ weekday: 6, time: "09:00" }, { weekday: 0, time: "09:00" }], "America/New_York", new Date("2026-10-31T00:00:00Z"), new Date("2026-11-02T00:00:00Z"));
    expect(slots.map((s) => s.toISOString())).toEqual(["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"]);
  });

  it("only uses slots on matching weekdays", () => {
    // 2026-11-10 is a Tuesday (2)
    const slots = expandSlots([{ weekday: 2, time: "09:30" }], KHI, new Date("2026-11-09T00:00:00Z"), new Date("2026-11-17T00:00:00Z"));
    expect(slots.map((s) => s.toISOString())).toEqual(["2026-11-10T04:30:00.000Z"]);
  });
});

describe("free slots", () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setupEnv(); // now = 2026-11-10 15:00 Karachi
  });
  afterEach(async () => env.close());

  async function approved(brandId: string, owner: Actor) {
    const p = await createPost(env.ctx(owner), { brandId, type: "image", media: [{ url: IMG }] });
    await submitForApproval(env.ctx(owner), { postId: p.id });
    return approvePost(env.ctx(owner), { postId: p.id });
  }

  it("next free slot is today 17:00 Karachi, then tomorrow once taken", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const a = await schedulePost(env.ctx(owner), { postId: (await approved(brand.id, owner)).id, nextFreeSlot: true });
    expect(a.scheduledAt).toBe("2026-11-10T12:00:00.000Z");
    expect(a.scheduledAtLocal).toBe("2026-11-10T17:00:00+05:00");
    const b = await schedulePost(env.ctx(owner), { postId: (await approved(brand.id, owner)).id, nextFreeSlot: true });
    expect(b.scheduledAt).toBe("2026-11-11T12:00:00.000Z");

    const free = await getFreeSlots(env.ctx(owner), { brandId: brand.id, limit: 2 });
    expect(free.slots.map((s) => s.local)).toEqual(["2026-11-12T17:00:00+05:00", "2026-11-13T17:00:00+05:00"]);
  });

  it("skips today's slot once it has passed", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    env.clock.set(new Date("2026-11-10T12:30:00Z")); // 17:30 Karachi
    const free = await getFreeSlots(env.ctx(owner), { brandId: brand.id, limit: 1 });
    expect(free.slots[0].local).toBe("2026-11-11T17:00:00+05:00");
  });

  it("rejects past times and explains how to publish now", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const p = await approved(brand.id, owner);
    await expect(schedulePost(env.ctx(owner), { postId: p.id, scheduledAt: "2026-11-10T14:00:00+05:00" })).rejects.toMatchObject({
      code: "validation_error",
      opts: { hint: expect.stringContaining("publish_now") },
    });
  });

  it("accepts explicit times with an offset and stores UTC", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const p = await approved(brand.id, owner);
    const s = await schedulePost(env.ctx(owner), { postId: p.id, scheduledAt: "2026-11-12T09:15:00+05:00" });
    expect(s.scheduledAt).toBe("2026-11-12T04:15:00.000Z");
    const r = await reschedulePost(env.ctx(owner), { postId: p.id, scheduledAt: "2026-11-12T21:00:00+05:00" });
    expect(r.scheduledAt).toBe("2026-11-12T16:00:00.000Z");
    expect(env.queue.pendingFor(p.id).map(([, j]) => j.at.toISOString())).toEqual(["2026-11-12T16:00:00.000Z"]);
  });

  it("explains when a brand has no posting slots", async () => {
    const brand = await makeBrand(env, { slug: "no-slots", postingSlots: [] });
    const owner = await makeUser(env, "owner");
    const p = await approved(brand.id, owner);
    await expect(schedulePost(env.ctx(owner), { postId: p.id, nextFreeSlot: true })).rejects.toMatchObject({ code: "no_free_slot" });
  });

  it("get_calendar groups posts by Karachi date", async () => {
    const brand = await makeBrand(env);
    const owner = await makeUser(env, "owner");
    const p = await approved(brand.id, owner);
    await schedulePost(env.ctx(owner), { postId: p.id, scheduledAt: "2026-11-11T02:00:00+05:00" }); // 2026-11-10 21:00Z
    const cal = await getCalendar(env.ctx(owner), { brandId: brand.id, from: "2026-11-01T00:00:00+05:00", to: "2026-12-01T00:00:00+05:00" });
    expect(Object.keys(cal.days)).toEqual(["2026-11-11"]);
  });
});
