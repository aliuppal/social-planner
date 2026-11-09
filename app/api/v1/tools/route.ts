import { connection } from "next/server";
import { restListTools } from "@/lib/mcp/rest";
import { getDeps } from "@/lib/runtime";

export async function GET(req: Request) {
  await connection(); // per-request (auth-dependent), never prerendered
  return restListTools(req, getDeps());
}
