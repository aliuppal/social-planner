import { restCallTool } from "@/lib/mcp/rest";
import { getDeps } from "@/lib/runtime";

export const maxDuration = 60;

export async function POST(req: Request, ctx: RouteContext<"/api/v1/tools/[name]">) {
  const { name } = await ctx.params;
  return restCallTool(req, getDeps(), name);
}
