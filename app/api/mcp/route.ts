import { handleMcpRequest } from "@/lib/mcp/server";
import { getDeps } from "@/lib/runtime";

// MCP over Streamable HTTP, stateless: every request is a self-contained JSON-RPC POST.
export const maxDuration = 60; // publish_now can wait on Instagram

export async function POST(req: Request) {
  return handleMcpRequest(req, getDeps());
}

const stateless = () =>
  Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "This MCP server is stateless: send JSON-RPC requests with POST." }, id: null }, { status: 405, headers: { Allow: "POST" } });

export const GET = stateless;
export const DELETE = stateless;
