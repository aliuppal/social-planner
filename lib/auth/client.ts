"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

/** Browser-side Better Auth client (same origin). */
export const authClient = createAuthClient({ plugins: [magicLinkClient()] });

/** Only allow same-site relative paths as post-login redirects. */
export function safeNext(next: string | null | undefined, fallback = "/dashboard") {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
}
