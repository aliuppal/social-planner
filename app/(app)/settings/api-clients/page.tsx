import type { Metadata } from "next";
import { requireOwner, userCtx } from "@/lib/auth/session";
import { listApiClients } from "@/lib/services/api-clients";
import { listBrands } from "@/lib/services/brands";
import { ApiClientsUI } from "@/components/settings/api-clients-ui";

export const metadata: Metadata = { title: "API keys · Social Planner" };

export default async function ApiClientsPage() {
  await requireOwner();
  const ctx = await userCtx();
  const [clients, brands] = await Promise.all([listApiClients(ctx), listBrands(ctx)]);
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">API keys</h1>
        <p className="mt-1 text-muted-foreground">Keys for Hermes, inqi and other tools using the MCP server or REST API. A key is shown once when created or rotated.</p>
      </div>
      <ApiClientsUI clients={clients} brands={brands.map((b) => ({ id: b.id, name: b.name }))} />
    </div>
  );
}
