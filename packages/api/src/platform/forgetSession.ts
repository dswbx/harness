import { removeStoredKeys, storedKeys } from "./storage";
import { matchKey } from "./storageKeys";

/**
 * Removes everything this app keeps for a deleted Session: every registered per-Session key
 * (layout, Side Thread tabs, files, review comments, drafts). Not for archiving. One scan of the
 * storage; keys of other Sessions and app keys stay. Returns the keys removed.
 */
export const forgetSession = (sessionId: string): string[] =>
   removeStoredKeys(
      storedKeys().filter((k) => {
         const m = matchKey(k);
         return m?.def.scope === "session" && m.session === sessionId;
      }),
   );
