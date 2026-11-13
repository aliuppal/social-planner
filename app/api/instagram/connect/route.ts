import { connection } from "next/server";
import { can } from "@/lib/auth/guard";
import { getSessionActor } from "@/lib/auth/session";
import { authorizeUrl, signState } from "@/lib/instagram/graph";
import { appUrl, getDeps } from "@/lib/runtime";
import { withActor } from "@/lib/services/context";
import { getAccessibleBrand } from "@/lib/services/brands";

/** Starts Business Login for Instagram for one brand: GET /api/instagram/connect?brand=<id>. */
export async function GET(req: Request) {
  await connection();
  const actor = await getSessionActor();
  if (!actor) return Response.redirect(`${appUrl()}/login`, 302);
  const brandId = new URL(req.url).searchParams.get("brand") ?? "";
  try {
    const brand = await getAccessibleBrand(withActor(getDeps(), actor), brandId);
    if (!can(actor, "brand.write", brand).ok) return Response.redirect(`${appUrl()}/brands/${brand.slug}?ig=forbidden`, 302);
    return Response.redirect(authorizeUrl(signState({ brandId: brand.id, userId: actor.userId })), 302);
  } catch (err) {
    const msg = encodeURIComponent(err instanceof Error ? err.message : "Couldn't start Instagram login");
    return Response.redirect(`${appUrl()}/brands?ig=error&message=${msg}`, 302);
  }
}
