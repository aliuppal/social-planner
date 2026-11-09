"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => obs.disconnect();
}

/** Current theme from the <html> class (dark unless `.light`). Server render assumes dark. */
export function useTheme(): "dark" | "light" {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.classList.contains("light") ? "light" : "dark"),
    () => "dark",
  );
}

/** Dark is default (like inqi). Choice is remembered per browser. */
export function ThemeToggle() {
  const light = useTheme() === "light";
  function toggle() {
    document.documentElement.classList.toggle("light", !light);
    try {
      localStorage.setItem("theme", light ? "dark" : "light");
    } catch {
      /* storage unavailable: theme still applies for this page */
    }
  }
  return (
    <button type="button" onClick={toggle} aria-label={light ? "Switch to dark theme" : "Switch to light theme"} className="glass grid size-11 place-items-center rounded-full">
      {light ? <Moon className="size-4" aria-hidden /> : <Sun className="size-4" aria-hidden />}
    </button>
  );
}
