import { useSyncExternalStore } from "react";

/**
 * Where a Frontend keeps a half-written prompt (localStorage), per composer: the Session id for the
 * Main Thread, `${sessionId}#${threadId}` for a Side Thread. Shared so the host can show which
 * Sessions have one (the sidebar's pencil) without knowing what a Frontend stores in it.
 */
const PREFIX = "harness.draft.";
const SEP = "#";

/** The composer key: the Session id (Main Thread) or `sessionId#threadId` (a Side Thread). */
export const draftKey = (sessionId: string, threadId: string | null): string =>
   threadId ? `${sessionId}${SEP}${threadId}` : sessionId;

/** Inverse of `draftKey` (the Session id has no `#`). */
export function parseDraftKey(key: string): { sessionId: string; threadId: string | null } {
   const i = key.indexOf(SEP);
   return i < 0
      ? { sessionId: key, threadId: null }
      : { sessionId: key.slice(0, i), threadId: key.slice(i + 1) };
}
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
      if (localStorage.getItem(draftStorageKey(draftKey(sessionId, null))) !== null) return true;
      for (let i = 0; i < localStorage.length; i++) {
         const k = localStorage.key(i);
         if (k?.startsWith(PREFIX) && parseDraftKey(k.slice(PREFIX.length)).sessionId === sessionId)
            return true;
      }
   } catch {
      // Storage blocked: no drafts.
   }
   return false;
}

export const useSessionHasDraft = (sessionId: string) =>
   useSyncExternalStore(subscribe, () => sessionHasDraft(sessionId));
