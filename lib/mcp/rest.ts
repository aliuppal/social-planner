import { authenticateApiKey } from "@/lib/services/api-clients";
import { withActor, type Deps } from "@/lib/services/context";
import { toAppError } from "@/lib/errors";
import { sanitizeError } from "@/lib/logger";
import { bearerToken } from "./server";
import { TOOLS, runTool, toolJsonSchema } from "./tools";

/**
 * REST mirror of the MCP tools for clients that don't speak MCP:
 *   GET  /api/v1/tools          → list tools with JSON Schemas
 *   POST /api/v1/tools/{name}   → body = tool arguments, response = tool result
 * Same API keys, scopes, validation and error shape.
 */
const unauthorized = () =>
  Response.json({ error: { code: "unauthorized", message: "Missing or invalid API key. Send Authorization: Bearer <api_key>." } }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="social-planner"' } });

export async function restListTools(req: Request, deps: Deps) {
  if (!(await authenticateApiKey(deps.db, bearerToken(req), deps.now()))) return unauthorized();
  return Response.json({ tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, scope: t.scope, readOnly: t.readOnly, inputSchema: toolJsonSchema(t) })) });
}

export async function restCallTool(req: Request, deps: Deps, name: string) {
  const actor = await authenticateApiKey(deps.db, bearerToken(req), deps.now());
  if (!actor) return unauthorized();
  let args: unknown = {};
  try {
    const text = await req.text();
    args = text ? JSON.parse(text) : {};
  } catch {
    return Response.json({ error: { code: "validation_error", message: "Request body must be JSON (the tool's arguments)." } }, { status: 400 });
  }
  try {
    return Response.json(await runTool(withActor(deps, actor), name, args));
  } catch (err) {
    const e = toAppError(err);
    if (e.code === "internal") deps.log.error({ tool: name, client: actor.name, err: sanitizeError(err) }, "rest tool error");
    return Response.json(e.toJSON(), { status: e.status });
  }
}
