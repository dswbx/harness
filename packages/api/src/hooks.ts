import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Event, PrRefKey } from "./generated";
import type { SessionApi } from "./client";
import type { PrEntry, PrStore } from "./prStore";
import { prKey } from "./prRefs";

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
    api
      .subscribe((e) => {
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
