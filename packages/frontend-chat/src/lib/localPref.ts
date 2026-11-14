import { useSyncExternalStore } from "react";

/** A per-viewer on/off choice (Settings > Appearance) kept in localStorage; every chat follows it, across windows too. */
export function localPref(key: string, fallback: boolean) {
   const listeners = new Set<() => void>();
   const read = () => {
      try {
         const v = localStorage.getItem(key);
         return v === null ? fallback : v === "on";
      } catch {
         return fallback;
      }
   };
   const subscribe = (f: () => void) => {
      listeners.add(f);
      const onStorage = (e: StorageEvent) => e.key === key && f();
      window.addEventListener("storage", onStorage);
      return () => {
         listeners.delete(f);
         window.removeEventListener("storage", onStorage);
      };
   };
   const set = (on: boolean) => {
      try {
         localStorage.setItem(key, on ? "on" : "off");
      } catch {
         /* per-viewer convenience only */
      }
      listeners.forEach((f) => f());
   };
   // The fallback when rendered without a window (tests render to static markup).
   const use = () => useSyncExternalStore(subscribe, read, () => fallback);
   return { use, set };
}
