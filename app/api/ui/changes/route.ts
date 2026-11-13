import { connection } from "next/server";
import { getSessionActor } from "@/lib/auth/session";
import { getDeps } from "@/lib/runtime";
import { withActor } from "@/lib/services/context";
import { getChangeCursor } from "@/lib/services/feed";

/** Live-update probe: open pages poll this every few seconds and refetch only when the cursor changes. */
export async function GET() {
  await connection();
  const actor = await getSessionActor();
  if (!actor) return Response.json({ cursor: null }, { status: 401 });
  return Response.json({ cursor: await getChangeCursor(withActor(getDeps(), actor)) }, { headers: { "Cache-Control": "no-store" } });
}
