"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const POLL_MS = 5_000;

/**
 * Polls /api/ui/changes while the tab is visible and calls onChange when the cursor moves
 * (posts created, moved, approved or published by anyone: users, Hermes, inqi, the publisher).
 */
export function useLiveChanges(onChange: () => void) {
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let last: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    async function tick() {
      if (document.visibilityState === "visible") {
        try {
          const r = await fetch("/api/ui/changes", { cache: "no-store" });
          if (r.ok) {
            const { cursor } = (await r.json()) as { cursor: string };
            if (last !== null && cursor !== last) cb.current();
            last = cursor;
          }
        } catch {
          /* offline: try again next tick */
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    }
    tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

/** Drop into any server-rendered page to re-render it when data changes elsewhere. */
export function LiveRefresh() {
  const router = useRouter();
  useLiveChanges(() => router.refresh());
  return null;
}
