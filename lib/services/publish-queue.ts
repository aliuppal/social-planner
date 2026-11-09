import { and, eq } from "drizzle-orm";
import { posts, type Post } from "@/lib/db/schema";
import { sanitizeError } from "@/lib/logger";
import type { Deps } from "./context";

/**
 * Keep the exact-time publish trigger (QStash message) in step with the post, after commit.
 * - entering `scheduled` or a new scheduledAt → cancel the old message, enqueue a new one
 * - leaving `scheduled` for anything but `publishing` → cancel the message
 * Queue failures never fail the user's request: the 5-minute sweep publishes anything due.
 * Stale messages are harmless because the publish job re-checks the post's state.
 */
export async function syncPublishJob(deps: Pick<Deps, "db" | "queue" | "log">, before: Post, after: Post): Promise<void> {
  const wasScheduled = before.status === "scheduled";
  const isScheduled = after.status === "scheduled";
  const timeChanged = before.scheduledAt?.getTime() !== after.scheduledAt?.getTime();
  const oldMsg = after.queueMessageId ?? before.queueMessageId;

  try {
    if (isScheduled && after.scheduledAt && (!wasScheduled || timeChanged || !after.queueMessageId)) {
      if (oldMsg) await deps.queue.cancel(oldMsg);
      const msgId = await deps.queue.enqueuePublish(after.id, after.scheduledAt);
      await deps.db
        .update(posts)
        .set({ queueMessageId: msgId })
        .where(and(eq(posts.id, after.id), eq(posts.status, "scheduled"), eq(posts.scheduledAt, after.scheduledAt)));
    } else if (wasScheduled && !isScheduled && after.status !== "publishing" && oldMsg) {
      await deps.queue.cancel(oldMsg);
      await deps.db.update(posts).set({ queueMessageId: null }).where(eq(posts.id, after.id));
    }
  } catch (err) {
    deps.log.warn({ postId: after.id, err: sanitizeError(err) }, "publish trigger sync failed; the sweep will cover it");
  }
}
