import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { SessionApi } from "./client";
import type { Event, PrRefKey, SharedArtifactEntry } from "./generated";
import { prKey } from "./prRefs";
import type { PrEntry, PrStore } from "./prStore";
import type { Unsubscribe } from "./transport";

/**
 * Subscribes once per `api` (StrictMode-safe), folds every Event through a pure reducer
 * (replay and live share one path), and unsubscribes on unmount. Events are batched per
 * animation frame so replays of large logs don't re-render per event. Once subscribed, it asks
 * the core to warm the Agent up so config options (models, modes) arrive before the first prompt.
 */
export function useSessionEvents<S>(
   api: SessionApi,
   reducer: (state: S, e: Event) => S,
   init: () => S,
   /** Folds many Events at once; defaults to folding `reducer` one by one. Must equal that fold. */
   batchReducer?: (state: S, events: readonly Event[]) => S,
): S {
   const [state, setState] = useState<S>(init);
   useEffect(() => {
      let cancelled = false;
      let unsub: (() => void) | undefined;
      let pending: Event[] = [];
      let raf = 0;
      const flush = () => {
         raf = 0;
         if (cancelled || pending.length === 0) return;
         const batch = pending;
         pending = [];
         setState((s) => (batchReducer ? batchReducer(s, batch) : batch.reduce(reducer, s)));
      };
      setState(init());
      api.subscribe((e) => {
         if (cancelled) return;
         pending.push(e);
         if (!raf) raf = requestAnimationFrame(flush);
      })
         .then((u) => {
            if (cancelled) u();
            else {
               unsub = u;
               // Best effort: failures (e.g. the Agent won't start) arrive as events.
               api.warmUp().catch(() => {});
            }
         })
         .catch((err) => console.error("subscribe failed", err));
      return () => {
         cancelled = true;
         if (raf) cancelAnimationFrame(raf);
         unsub?.();
      };
      // reducer/init are expected to be stable module-level functions
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [api]);
   return state;
}

/** A PR reference's info from `store`; asks for it on mount and whenever its cache entry changes (so expired ones refresh). */
export function usePr(store: PrStore, key: PrRefKey): PrEntry {
   const id = prKey(key);
   // eslint-disable-next-line react-hooks/exhaustive-deps
   const peek = useCallback(() => store.peek(key), [store, id]);
   const entry = useSyncExternalStore(store.subscribe, peek);
   // eslint-disable-next-line react-hooks/exhaustive-deps
   useEffect(() => store.request(key), [store, id, entry]);
   return entry;
}

/** Where `useSharedArtifacts` reads from: a `SessionApi` or a `HarnessClient`'s functions. */
export type SharedListSource = {
   list: () => Promise<SharedArtifactEntry[]>;
   onListChanged: (onChange: () => void) => Promise<Unsubscribe>;
};

/**
 * All Shared Artifacts (ADR 0024), most recently updated first (null while loading). Loaded once and
 * again on each `SharedArtifactsChanged`. `source` must be stable (memoize it).
 */
export function useSharedArtifacts(source: SharedListSource): SharedArtifactEntry[] | null {
   const [list, setList] = useState<SharedArtifactEntry[] | null>(null);
   useEffect(() => {
      let live = true;
      const load = () =>
         source.list().then(
            (l) => live && setList(l),
            (e) => console.error("list shared artifacts failed", e),
         );
      void load();
      const off = source.onListChanged(() => void load());
      return () => {
         live = false;
         void off.then((f) => f());
      };
   }, [source]);
   return list;
}
