import { connection } from "next/server";
import { getSessionActor } from "@/lib/auth/session";
import { toAppError } from "@/lib/errors";
import { getDeps } from "@/lib/runtime";
import { withActor } from "@/lib/services/context";
import { calendarFeed } from "@/lib/services/feed";

/** Calendar feed for the signed-in user: GET ?from&to[&brandId|&calendarId] (ISO datetimes). */
export async function GET(req: Request) {
  await connection();
  const actor = await getSessionActor();
  if (!actor) return Response.json({ error: { code: "unauthorized", message: "Sign in again." } }, { status: 401 });
  const q = new URL(req.url).searchParams;
  try {
    const items = await calendarFeed(withActor(getDeps(), actor), {
      from: q.get("from") ?? "",
      to: q.get("to") ?? "",
      brandId: q.get("brandId") || undefined,
      calendarId: q.get("calendarId") || undefined,
    });
    return Response.json({ items });
  } catch (err) {
    const e = toAppError(err);
    return Response.json(e.toJSON(), { status: e.status });
  }
}
