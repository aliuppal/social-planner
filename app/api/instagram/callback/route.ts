import { connection } from "next/server";
import { getSessionActor } from "@/lib/auth/session";
import { exchangeCode, verifyState } from "@/lib/instagram/graph";
import { sanitizeError } from "@/lib/logger";
import { appUrl, getDeps } from "@/lib/runtime";
import { withActor } from "@/lib/services/context";
import { getAccessibleBrand } from "@/lib/services/brands";
import { connectAccount } from "@/lib/services/instagram";

/** OAuth redirect target (register this exact URL in the Meta app). */
export async function GET(req: Request) {
  await connection();
  const q = new URL(req.url).searchParams;
  const back = (path: string, params: Record<string, string>) => Response.redirect(`${appUrl()}${path}?${new URLSearchParams(params)}`, 302);

  const state = verifyState(q.get("state") ?? "");
  if (!state) return back("/brands", { ig: "error", message: "The Instagram login link expired or was tampered with. Try connecting again." });
  const actor = await getSessionActor();
  if (!actor || actor.userId !== state.userId) return back("/login", { next: "/brands" });

  const deps = getDeps();
  const ctx = withActor(deps, actor);
  const brand = await getAccessibleBrand(ctx, state.brandId).catch(() => null);
  if (!brand) return back("/brands", { ig: "error", message: "Brand not found." });
  if (q.get("error")) return back(`/brands/${brand.slug}`, { ig: "cancelled", message: q.get("error_description") ?? "Instagram login was cancelled." });

  try {
    const profile = await exchangeCode(q.get("code") ?? "");
    const r = await connectAccount(ctx, brand.id, profile);
    return back(`/brands/${brand.slug}`, { ig: "connected", ...(r.warning ? { message: r.warning } : {}) });
  } catch (err) {
    deps.log.warn({ brandId: brand.id, err: sanitizeError(err) }, "instagram connect failed");
    return back(`/brands/${brand.slug}`, { ig: "error", message: sanitizeError(err, 200) });
  }
}
