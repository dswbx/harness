import { removeStoredKeys, storedKeys } from "./storage";
import { matchKey } from "./storageKeys";

const forgotten = new Set<(sessionId: string) => void>();
/** For a module that caches per-Session stores: drop them when the Session is forgotten. */
export function onSessionForgotten(l: (sessionId: string) => void): () => void {
   forgotten.add(l);
   return () => void forgotten.delete(l);
}

/**
 * Removes everything this app keeps for a deleted Session: every registered per-Session key
 * (layout, Side Thread tabs, files, review comments, drafts). Not for archiving. One scan of the
 * storage; keys of other Sessions and app keys stay. Returns the keys removed.
 */
export function forgetSession(sessionId: string): string[] {
   const removed = removeStoredKeys(
      storedKeys().filter((k) => {
         const m = matchKey(k);
         return m?.def.scope === "session" && m.session === sessionId;
      }),
   );
   for (const l of forgotten) l(sessionId);
   return removed;
}
