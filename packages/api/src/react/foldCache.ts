import { onSessionForgotten } from "../platform/forgetSession";

/** How many Sessions keep their folded state after their View unmounts. */
const FOLD_CACHE_SESSIONS = 5;
/** A folded state and the `seq` to load from next: always the fold of every Event below `next`. */
export type Fold = { state: unknown; next: number };
/**
 * Folded state of recently shown Sessions, so switching back to one renders at once and loads only
 * what came since. Only for callers that opt in (`useSessionEvents`'s `cache`): a fold can be big.
 * Per Session (least recently used first), then per reducer: Views with different reducers fold the
 * same log to different states. Valid for the app's life: a Session Log is only appended to and its
 * `seq` never goes back while the core runs (log.rs), and the core runs as long as this window.
 * Dropped when the Session is forgotten (deleted). Not in the public entry.
 */
const folds = new Map<string, Map<unknown, Fold>>();
onSessionForgotten((id) => void folds.delete(id));

export function readFold(sessionId: string, reducer: unknown): Fold | undefined {
   const bySession = folds.get(sessionId);
   const fold = bySession?.get(reducer);
   if (bySession && fold) {
      folds.delete(sessionId);
      folds.set(sessionId, bySession);
   }
   return fold;
}

/** Keeps the newest fold: a second View of the Session that is behind does not move it back. */
export function writeFold(sessionId: string, reducer: unknown, fold: Fold) {
   const bySession = folds.get(sessionId) ?? new Map<unknown, Fold>();
   if ((bySession.get(reducer)?.next ?? -1) <= fold.next) bySession.set(reducer, fold);
   folds.delete(sessionId);
   folds.set(sessionId, bySession);
   for (const id of folds.keys()) {
      if (folds.size <= FOLD_CACHE_SESSIONS) break;
      folds.delete(id);
   }
}

/** Test hook: empties the fold cache. @internal */
export function clearFoldCache() {
   folds.clear();
}
