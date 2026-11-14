import { useSyncExternalStore } from "react";
import { hasStoredKey, onStoredChange, storageIdentity, storedKeys } from "../platform/storage";

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

/** Session id to the storage keys of its drafts: built by one scan, then kept current by writes and the `storage` event. */
let index: Map<string, Set<string>> | null = null;
let indexedStorage: unknown;
let hooked = false;

/** Updates the index for a changed draft key; whether the Session's has-a-draft answer changed. */
function track(key: string): boolean {
   if (!index) return false;
   const sessionId = parseDraftKey(key.slice(PREFIX.length)).sessionId;
   const keys = index.get(sessionId);
   if (hasStoredKey(key)) {
      if (keys) keys.add(key);
      else index.set(sessionId, new Set([key]));
      return !keys;
   }
   if (!keys) return false;
   keys.delete(key);
   if (keys.size) return false;
   index.delete(sessionId);
   return true;
}

function currentIndex(): Map<string, Set<string>> {
   if (!hooked) {
      hooked = true;
      onStoredChange((key) => {
         // Typing into a draft that exists changes nothing the sidebar shows: no wake-up.
         const changed = key === null || (key.startsWith(PREFIX) && track(key));
         if (key === null) index = null;
         if (changed) for (const l of [...listeners]) l();
      });
   }
   const st = storageIdentity();
   if (!index || indexedStorage !== st) {
      indexedStorage = st;
      index = new Map();
      for (const k of storedKeys()) if (k.startsWith(PREFIX)) track(k);
   }
   return index;
}

const listeners = new Set<() => void>();
export function onSessionDraftsChange(l: () => void) {
   currentIndex();
   listeners.add(l);
   return () => void listeners.delete(l);
}

/** Whether any composer of the Session (Main or a Side Thread) holds a draft. No scan per call. */
export const sessionHasDraft = (sessionId: string): boolean => currentIndex().has(sessionId);

export const useSessionHasDraft = (sessionId: string) =>
   useSyncExternalStore(
      onSessionDraftsChange,
      () => sessionHasDraft(sessionId),
      () => false,
   );
