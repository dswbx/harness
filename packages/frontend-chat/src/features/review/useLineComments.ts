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

const none = () => () => {};

/**
 * The Session's Review Comments for views that have no `ChatState` (the diff and Files panels, and their
 * pop-out windows). No Session (a Folder Diff): none.
 */
export function useLineComments(api: SessionApi | undefined): readonly LineCommentState[] {
   const apiRef = useRef(api);
   apiRef.current = api;
   const sessionId = api?.sessionId;
   // Stable per Session: a new function each render would resubscribe (and replay) in a loop.
   // biome-ignore lint/correctness/useExhaustiveDependencies: `apiRef` is a ref; the Session id keys the subscription.
   const subscribe = useCallback(
      (cb: () => void) => (apiRef.current ? subscribeTo(apiRef.current, cb) : none()),
      [sessionId],
   );
   return useSyncExternalStore(
      subscribe,
      () => (sessionId ? (entries.get(sessionId)?.list ?? EMPTY) : EMPTY),
      () => EMPTY,
   );
}
