import { refreshLongLivedToken } from "@/lib/instagram/graph";
import { sanitizeError } from "@/lib/logger";
import { isAuthorizedJob } from "@/lib/queue/qstash";
import { getDeps } from "@/lib/runtime";
import { refreshTokens, syncAllBrands } from "@/lib/services/instagram";
import { publishPost, runDuePublishes } from "@/lib/services/publisher";

/**
 * Background jobs, called by QStash (signed) or manually with `Authorization: Bearer <CRON_SECRET>`:
 *   publish  {postId}  exact-time trigger for one post
 *   sweep              every 5 min: anything due that a trigger missed
 *   sync               every 30 min: import posts made in the Instagram app
 *   tokens             daily: refresh long-lived Instagram tokens
 * Always answers 200 once authorised: the publisher handles its own retries, so QStash shouldn't.
 */
export const maxDuration = 60;

export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[job]">) {
  const { job } = await ctx.params;
  const raw = await req.text();
  if (!(await isAuthorizedJob(req, raw))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const deps = getDeps();
  try {
    switch (job) {
      case "publish": {
        const { postId } = JSON.parse(raw || "{}") as { postId?: string };
        if (!postId) return Response.json({ error: "postId required" }, { status: 400 });
        return Response.json(await publishPost(deps, postId));
      }
      case "sweep":
        return Response.json({ results: await runDuePublishes(deps, { limit: 20 }) });
      case "sync":
        return Response.json({ results: await syncAllBrands(deps) });
      case "tokens":
        return Response.json({ results: await refreshTokens(deps, refreshLongLivedToken) });
      default:
        return Response.json({ error: `unknown job '${job}'` }, { status: 404 });
    }
  } catch (err) {
    deps.log.error({ job, err: sanitizeError(err) }, "job failed");
    return Response.json({ error: sanitizeError(err, 200) }, { status: 200 });
  }
}
