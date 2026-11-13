import { Client, Receiver } from "@upstash/qstash";
import type { JobQueue } from "@/lib/services/context";

/**
 * Exact-time publish triggers via Upstash QStash: one message per scheduled post, delivered at
 * `notBefore` to /api/jobs/publish. The handler re-checks the post, so stale messages are harmless,
 * and the 5-minute sweep covers anything a message missed (e.g. beyond the plan's max delay).
 */
export class QStashQueue implements JobQueue {
  private client: Client;
  constructor(
    token: string,
    private appUrl: string,
  ) {
    this.client = new Client({ token, baseUrl: process.env.QSTASH_URL });
  }

  async enqueuePublish(postId: string, at: Date) {
    const res = await this.client.publishJSON({
      url: `${this.appUrl.replace(/\/$/, "")}/api/jobs/publish`,
      body: { postId },
      notBefore: Math.max(Math.floor(at.getTime() / 1000), Math.floor(Date.now() / 1000)),
      retries: 3,
    });
    return res.messageId;
  }

  async cancel(messageId: string) {
    try {
      await this.client.messages.cancel(messageId);
    } catch {
      // already delivered or gone: nothing to cancel
    }
  }
}

/** Jobs accept a valid QStash signature, or `Authorization: Bearer <CRON_SECRET>` for manual runs. */
export async function isAuthorizedJob(req: Request, rawBody: string): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth === `Bearer ${secret}`) return true;
  const signature = req.headers.get("upstash-signature");
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!signature || !current || !next) return false;
  try {
    return await new Receiver({ currentSigningKey: current, nextSigningKey: next }).verify({ signature, body: rawBody });
  } catch {
    return false;
  }
}
