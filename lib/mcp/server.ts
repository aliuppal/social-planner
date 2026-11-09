import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ApiClientActor } from "@/lib/auth/guard";
import { toAppError } from "@/lib/errors";
import { sanitizeError } from "@/lib/logger";
import { authenticateApiKey } from "@/lib/services/api-clients";
import { getBrand, listBrands } from "@/lib/services/brands";
import { getCalendar } from "@/lib/services/calendars";
import { withActor, type Ctx, type Deps } from "@/lib/services/context";
import { monthRangeUtc, utcToZonedParts } from "@/lib/time";
import { TOOLS, runTool, toolJsonSchema } from "./tools";

export const MCP_SERVER_INFO = { name: "social-planner", version: "1.0.0" };

const INSTRUCTIONS = `Social Planner: multi-brand Instagram calendar.
Typical flow: list_brands → get_brand (read guidelines before writing) → create_post (with media URLs) → submit_for_approval → approve_post (by a key with posts:approve) → schedule_post {nextFreeSlot:true} → it publishes automatically.
Times are ISO-8601 with an offset; the brand's timezone is in get_brand. Mutations that edit a post take the post's current \`version\`.
Errors come back as JSON {error:{code,message,details?,hint?}}; fix the call using details/hint.`;

const DESTRUCTIVE = new Set(["cancel_post", "remove_media", "publish_now", "reject_post"]);

/** One MCP server per request (stateless), bound to the authenticated API client. */
export function createMcpServer(ctx: Ctx) {
  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS });
  const clientName = ctx.actor.kind === "api_client" ? ctx.actor.name : ctx.actor.kind;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: `${t.description} Requires scope: ${t.scope}.`,
      inputSchema: toolJsonSchema(t),
      annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: DESTRUCTIVE.has(t.name), idempotentHint: t.readOnly, openWorldHint: t.name === "publish_now" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const started = Date.now();
    try {
      const result = await runTool(ctx, req.params.name, req.params.arguments);
      ctx.log.info({ tool: req.params.name, client: clientName, ms: Date.now() - started }, "mcp tool ok");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      const e = toAppError(err);
      const level = e.code === "internal" ? "error" : "info";
      ctx.log[level]({ tool: req.params.name, client: clientName, code: e.code, ms: Date.now() - started, ...(e.code === "internal" ? { err: sanitizeError(err) } : {}) }, "mcp tool error");
      return { isError: true, content: [{ type: "text", text: JSON.stringify(e.toJSON()) }] };
    }
  });

  // ---------- Resources ----------
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: "brand://{slug}/guidelines", name: "brand-guidelines", title: "Brand guidelines", description: "Voice, pillars, palette, do/don't rules, hashtag sets, CTA and posting slots.", mimeType: "application/json" },
      { uriTemplate: "brand://{slug}/calendar/{yyyy-mm}", name: "brand-calendar-month", title: "Brand calendar month", description: "All posts of the month grouped by day in the brand timezone.", mimeType: "application/json" },
    ],
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const brands = await listBrands(ctx).catch(() => []);
    return {
      resources: brands.flatMap((b) => {
        const p = utcToZonedParts(ctx.now(), b.timezone);
        const month = `${p.year}-${String(p.month).padStart(2, "0")}`;
        return [
          { uri: `brand://${b.slug}/guidelines`, name: `${b.slug}-guidelines`, title: `${b.name} guidelines`, mimeType: "application/json" },
          { uri: `brand://${b.slug}/calendar/${month}`, name: `${b.slug}-calendar-${month}`, title: `${b.name} calendar ${month}`, mimeType: "application/json" },
        ];
      }),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const guide = /^brand:\/\/([a-z0-9-]+)\/guidelines$/.exec(uri);
    const cal = /^brand:\/\/([a-z0-9-]+)\/calendar\/(\d{4}-(0[1-9]|1[0-2]))$/.exec(uri);
    try {
      let body: unknown;
      if (guide) {
        const b = await getBrand(ctx, guide[1]);
        body = { brand: { name: b.name, slug: b.slug, instagramHandle: b.instagramHandle, timezone: b.timezone }, requiresApproval: b.requiresApproval, guidelines: b.guidelines, postingSlots: b.postingSlots };
      } else if (cal) {
        const b = await getBrand(ctx, cal[1]);
        const { from, to } = monthRangeUtc(b.timezone, cal[2]);
        body = await getCalendar(ctx, { brandId: b.id, from: from.toISOString(), to: to.toISOString() });
      } else {
        throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI '${uri}'. Use brand://{slug}/guidelines or brand://{slug}/calendar/{yyyy-mm}.`);
      }
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body) }] };
    } catch (err) {
      if (err instanceof McpError) throw err;
      const e = toAppError(err);
      throw new McpError(e.code === "not_found" ? -32002 : ErrorCode.InvalidParams, e.message, e.toJSON().error);
    }
  });

  return server;
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

export function unauthorized(message = "Missing or invalid API key. Send Authorization: Bearer <api_key>.") {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message, data: { code: "unauthorized" } }, id: null },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="social-planner"' } },
  );
}

/** Authenticate the API key, then let the SDK's stateless Streamable HTTP transport answer. */
export async function handleMcpRequest(req: Request, deps: Deps): Promise<Response> {
  const actor: ApiClientActor | null = await authenticateApiKey(deps.db, bearerToken(req), deps.now());
  if (!actor) return unauthorized();
  const server = createMcpServer(withActor(deps, actor));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close().catch(() => undefined);
  }
}
