import { useSyncExternalStore } from "react";

// Per-viewer choice (Settings > Appearance), off by default like VS Code: Option types the layout's characters
// (@ [ ] { } on many layouts). On, Option is Meta (Esc prefix) for shell shortcuts such as Opt+B. Every terminal follows it, across windows too.
const KEY = "harness.terminal.optionIsMeta";
const listeners = new Set<() => void>();
export const readOptionIsMeta = () => {
   try {
      return localStorage.getItem(KEY) === "on";
   } catch {
      return false;
   }
};
export const onOptionIsMetaChange = (f: () => void) => {
   listeners.add(f);
   const onStorage = (e: StorageEvent) => e.key === KEY && f();
   window.addEventListener("storage", onStorage);
   return () => {
      listeners.delete(f);
      window.removeEventListener("storage", onStorage);
   };
};

export function setOptionIsMeta(on: boolean) {
   try {
      localStorage.setItem(KEY, on ? "on" : "off");
   } catch {
      /* per-viewer convenience only */
   }
   listeners.forEach((f) => f());
}

/** Whether the terminal's Option key is Meta instead of typing characters (macOS). */
export const useOptionIsMeta = () => useSyncExternalStore(onOptionIsMetaChange, readOptionIsMeta);
