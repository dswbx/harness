import { useSyncExternalStore } from "react";

/**
 * Where a Frontend keeps a half-written prompt (localStorage), per composer: the Session id for the
 * Main Thread, `${sessionId}#${threadId}` for a Side Thread. Shared so the host can show which
 * Sessions have one (the sidebar's pencil) without knowing what a Frontend stores in it.
 */
const PREFIX = "harness.draft.";
export const draftStorageKey = (composerKey: string) => PREFIX + composerKey;

const listeners = new Set<() => void>();
/** A Frontend changed a draft: tell this window (other windows get the `storage` event). */
export function notifyDraftsChanged() {
   for (const l of listeners) l();
}
function subscribe(l: () => void) {
   listeners.add(l);
   const onStorage = (e: StorageEvent) => (!e.key || e.key.startsWith(PREFIX)) && l();
   window.addEventListener("storage", onStorage);
   return () => {
      listeners.delete(l);
      window.removeEventListener("storage", onStorage);
   };
}

/** Whether any composer of the Session (Main or a Side Thread) holds a draft. */
export function sessionHasDraft(sessionId: string): boolean {
   try {
      const main = draftStorageKey(sessionId);
      if (localStorage.getItem(main) !== null) return true;
      for (let i = 0; i < localStorage.length; i++)
         if (localStorage.key(i)?.startsWith(`${main}#`)) return true;
   } catch {
      // Storage blocked: no drafts.
   }
   return false;
}

export const useSessionHasDraft = (sessionId: string) =>
   useSyncExternalStore(subscribe, () => sessionHasDraft(sessionId));
