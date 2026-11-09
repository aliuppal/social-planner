import { and, eq, exists, or, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db";
import { apiClientBrands, apiClients, webhookDeliveries, webhooks } from "@/lib/db/schema";
import type { Ctx } from "./context";

export const WEBHOOK_EVENTS = ["post.status_changed", "post.published", "post.failed", "account.token_expiring"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/**
 * Outbox: called inside the same transaction as the change, so a delivery row exists
 * if and only if the change committed. Delivery (signed POST via QStash) runs in phase 6.
 * Only webhooks owned by API clients with access to the brand receive the event.
 */
export async function emitEvent(
  tx: DbOrTx,
  ctx: Pick<Ctx, "now">,
  e: { event: WebhookEvent; brandId: string; payload: Record<string, unknown> },
): Promise<number> {
  const targets = await tx
    .select({ id: webhooks.id })
    .from(webhooks)
    .innerJoin(apiClients, eq(apiClients.id, webhooks.apiClientId))
    .where(
      and(
        eq(webhooks.active, true),
        sql`${apiClients.revokedAt} is null`,
        sql`${e.event} = any(${webhooks.events})`,
        or(
          eq(apiClients.allBrands, true),
          exists(
            tx
              .select({ one: sql`1` })
              .from(apiClientBrands)
              .where(and(eq(apiClientBrands.apiClientId, apiClients.id), eq(apiClientBrands.brandId, e.brandId))),
          ),
        ),
      ),
    );
  if (!targets.length) return 0;
  const now = ctx.now();
  await tx.insert(webhookDeliveries).values(
    targets.map((t) => ({
      webhookId: t.id,
      event: e.event,
      payload: { event: e.event, occurredAt: now.toISOString(), data: e.payload },
      nextAttemptAt: now,
    })),
  );
  return targets.length;
}
