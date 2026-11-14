import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionApi } from "../client/client";
import { type GitStatusSnapshot, gitStatusStore } from "../client/gitStatusStore";
import type { Event, PrRefKey, SharedArtifactEntry } from "../generated";
import { prKey } from "../github/prRefs";
import type { PrEntry, PrStore } from "../github/prStore";
import type { Unsubscribe } from "../transport/transport";

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

const NO_STATUS: GitStatusSnapshot = { isRepo: null, status: null, error: null, changes: 0 };
const noop = () => {};

/**
 * The Session folder's git status from the shared store (one poll per Session however many views use it).
 * Nothing polls for a null `api` or `enabled: false` (e.g. a folder known not to be a repository).
 * `status: false` only wants `isRepo`. A new `refreshKey` loads again. `changes` counts status changes seen
 * since this view mounted.
 */
export function useGitStatus(
   api: Pick<SessionApi, "sessionId" | "gitStatus" | "workspace"> | null,
   {
      enabled = true,
      status = true,
      refreshKey,
   }: { enabled?: boolean; status?: boolean; refreshKey?: unknown } = {},
): GitStatusSnapshot & { refresh: () => Promise<void> } {
   const sessionId = api?.sessionId;
   // One store per Session id for the app's life; `api` is only used to create it.
   // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the Session id.
   const store = useMemo(() => (api && enabled ? gitStatusStore(api) : null), [sessionId, enabled]);
   const subscribe = useCallback(
      (l: () => void) => (store ? store.subscribe(l, { status }) : noop),
      [store, status],
   );
   const peek = useCallback(() => store?.peek() ?? NO_STATUS, [store]);
   const snap = useSyncExternalStore(subscribe, peek);
   // Changes seen before this view's own first load finished are not its changes.
   const [base, setBase] = useState(snap.changes);
   const last = useRef<{ store: unknown; key: unknown } | null>(null);
   // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` only triggers a reload.
   useEffect(() => {
      if (!store) return;
      if (last.current?.store !== store) {
         // The subscription started the first load.
         last.current = { store, key: refreshKey };
         void store.settled().then(() => setBase(store.peek().changes));
      } else if (last.current.key !== refreshKey) {
         last.current.key = refreshKey;
         void store.refresh();
      }
   }, [store, refreshKey]);
   const refresh = useCallback(() => store?.refresh() ?? Promise.resolve(), [store]);
   return { ...snap, changes: Math.max(0, snap.changes - base), refresh };
}
