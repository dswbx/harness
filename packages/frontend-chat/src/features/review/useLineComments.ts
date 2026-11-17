import {
   type LineCommentState,
   type SessionApi,
   stepLineComments,
   type Unsubscribe,
} from "@harness/api";
import { useCallback, useRef, useSyncExternalStore } from "react";

type Entry = {
   list: readonly LineCommentState[];
   listeners: Set<() => void>;
   off: Promise<Unsubscribe | null>;
};

const EMPTY: readonly LineCommentState[] = [];
const entries = new Map<string, Entry>();

/** One shared subscription per Session folding the log into its Review Comments (ADR 0027). */
function subscribeTo(api: SessionApi, cb: () => void) {
   let e = entries.get(api.sessionId);
   if (!e) {
      const entry: Entry = { list: EMPTY, listeners: new Set(), off: Promise.resolve(null) };
      entry.off = api
         .subscribe((ev) => {
            const next = stepLineComments(entry.list, ev);
            if (next === entry.list) return;
            entry.list = next;
            for (const l of entry.listeners) l();
         })
         .catch(() => null);
      entries.set(api.sessionId, entry);
      e = entry;
   }
   const entry = e;
   entry.listeners.add(cb);
   return () => {
      entry.listeners.delete(cb);
      if (entry.listeners.size > 0) return;
      if (entries.get(api.sessionId) === entry) entries.delete(api.sessionId);
      void entry.off.then((off) => off?.());
   };
}

/**
 * The Session's Review Comments for views that have no `ChatState` (the diff and Files panels, and their
 * pop-out windows).
 */
export function useLineComments(api: SessionApi): readonly LineCommentState[] {
   const apiRef = useRef(api);
   apiRef.current = api;
   // Stable per Session: a new function each render would resubscribe (and replay) in a loop.
   // biome-ignore lint/correctness/useExhaustiveDependencies: `apiRef` is a ref; the Session id keys the subscription.
   const subscribe = useCallback(
      (cb: () => void) => subscribeTo(apiRef.current, cb),
      [api.sessionId],
   );
   return useSyncExternalStore(
      subscribe,
      () => entries.get(api.sessionId)?.list ?? EMPTY,
      () => EMPTY,
   );
}
