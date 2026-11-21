import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionApi } from "../client/client";
import { type GitStatusSnapshot, gitStatusStore } from "../client/gitStatusStore";
import type { Event, Note, PrRefKey, SharedArtifactEntry, TaskSummary } from "../generated";
import { prKey } from "../github/prRefs";
import type { PrEntry, PrStore } from "../github/prStore";
import { withRetry } from "../transport/retry";
import type { Unsubscribe } from "../transport/transport";
import { readFold, writeFold } from "./foldCache";

/**
 * How far a View has loaded its Session Log: Events below `next` are folded; it is whole once
 * `next >= end`. `failed`: page reads still failed after their retries; the load stopped and live
 * Events are not followed.
 */
export type LogLoad = { next: number; end: number } | { next: number; failed: true };

export type SessionEventsOptions = {
   /**
    * Keep the fold after unmount (see `foldCache.ts`): mounted again, the View renders it at once
    * and loads only from its `next`. Only for a small state a View switches back to often (the chat
    * View's); others fold from the start and free their state on unmount.
    */
   cache?: boolean;
   /** Called after each page, once the log is whole, and when the load failed. */
   onLoad?: (load: LogLoad) => void;
};

/**
 * Loads the Session Log once per `api` (StrictMode-safe) and folds every Event through a pure
 * reducer, then stays live; unsubscribes on unmount. The log comes in pages up to the `end` of the
 * first one (ADR 0029), each folded as it lands, one asked for after the other, so an unmount stops
 * the load. A failed page read is tried again with a growing delay; when it still fails, the load
 * stops: unsubscribed, nothing held, `onLoad` gets `failed`. Live Events come from a subscription
 * that starts at that `end`: held until the last page is folded, then folded on top, so there is no
 * gap and no duplicate. The first render waits for the whole log (a part of it would render a Turn
 * without its end as running, and rows would shift as the rest lands); after that, live Events are
 * batched per animation frame. Once subscribed, it asks the core to warm the Agent up so config
 * options (models, modes) arrive before the first prompt. With `cache`, a cached fold renders at
 * once: it can be behind the log until the load is whole (`onLoad`).
 * `reducer`, `init`, `batchReducer` and `options` are read once per `api`.
 */
export function useSessionEvents<S>(
   api: SessionApi,
   reducer: (state: S, e: Event) => S,
   init: () => S,
   /** Folds many Events at once; defaults to folding `reducer` one by one. Must equal that fold. */
   batchReducer?: (state: S, events: readonly Event[]) => S,
   options: SessionEventsOptions = {},
): S {
   const { cache = false, onLoad } = options;
   const [state, setState] = useState<S>(
      () =>
         ((cache ? readFold(api.sessionId, reducer)?.state : undefined) as S | undefined) ?? init(),
   );
   // biome-ignore lint/correctness/useExhaustiveDependencies: reducer, init, batchReducer and options are read once per `api` (stable module-level functions).
   useEffect(() => {
      const sessionId = api.sessionId;
      const cached = cache ? readFold(sessionId, reducer) : undefined;
      // This View's own fold: the fold of every Event below `next`. Written to the cache only
      // once the log is whole, so a later mount never takes a part for the whole.
      let folded = (cached?.state as S | undefined) ?? init();
      let next = cached?.next ?? 0;
      // Aborted on unmount, and when the load fails: stops paging, retries and the subscription.
      const stop = new AbortController();
      const cancelled = () => stop.signal.aborted;
      let loaded = false;
      let unsub: (() => void) | undefined;
      // Live Events not folded yet: all of them while the log loads, then one frame's worth.
      let pending: Event[] = [];
      let raf = 0;
      const fold = (events: readonly Event[]) => {
         // Pages and live never overlap; this only guards the fold's invariant.
         const fresh =
            (events[0]?.seq ?? next) < next ? events.filter((e) => e.seq >= next) : events;
         const last = fresh.at(-1);
         if (!last) return;
         folded = batchReducer ? batchReducer(folded, fresh) : fresh.reduce(reducer, folded);
         next = last.seq + 1;
      };
      const show = () => {
         if (cache) writeFold(sessionId, reducer, { state: folded, next });
         const shown = folded;
         setState(() => shown);
      };
      const flush = () => {
         raf = 0;
         if (cancelled() || pending.length === 0) return;
         const batch = pending;
         pending = [];
         fold(batch);
         show();
      };
      const read = (toSeq?: number) => withRetry(() => api.readLogPage(next, toSeq), stop.signal);
      const load = async () => {
         let page = await read();
         if (cancelled()) return;
         const end = page.end;
         api.subscribe(
            (e) => {
               if (cancelled()) return;
               pending.push(e);
               if (loaded && !raf) raf = requestAnimationFrame(flush);
            },
            end,
            stop.signal,
         )
            .then((u) => {
               if (cancelled()) u();
               else {
                  unsub = u;
                  // Best effort: failures (e.g. the Agent won't start) arrive as events.
                  api.warmUp().catch(() => {});
               }
            })
            .catch((err) => console.error("subscribe failed", err));
         for (;;) {
            fold(page.events);
            if (!page.more) break;
            onLoad?.({ next, end });
            page = await read(end);
            if (cancelled()) return;
         }
         // Every Event below `end` is folded (the log may skip a `seq`).
         next = Math.max(next, end);
         loaded = true;
         fold(pending);
         pending = [];
         show();
         onLoad?.({ next, end });
      };
      setState(() => folded);
      load().catch((err) => {
         if (cancelled()) return;
         // Do not hold live Events for a load that will not end.
         stop.abort();
         unsub?.();
         unsub = undefined;
         pending = [];
         console.error(`loading the Session Log of ${sessionId} failed; the View stops here`, err);
         onLoad?.({ next, failed: true });
      });
      return () => {
         stop.abort();
         if (raf) cancelAnimationFrame(raf);
         unsub?.();
      };
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

/** Where `useTasks` reads from: a `SessionApi` or a `HarnessClient` (both hold the window's one `taskStore`). */
export type TaskListSource = Pick<SessionApi, "taskStore">;

/**
 * All Tasks (ADR 0028), oldest first (null while loading). Every caller in a window shares one list:
 * loaded once, then patched from each `TasksChanged` (see `TaskStore`).
 */
export function useTasks(source: TaskListSource): TaskSummary[] | null {
   const store = source.taskStore;
   return useSyncExternalStore(store.subscribe, store.peek);
}

/**
 * The Session's Session Note (ADR 0028), null while loading. Read once and again on each `NoteChanged`.
 * `set` puts a Note the caller got back from a write, so it shows before the re-read. A read that
 * started before a newer one (or a `set`) is dropped.
 */
export function useNote(
   api: Pick<SessionApi, "readNote" | "noteChanged">,
): [Note | null, (note: Note) => void] {
   const [note, setNote] = useState<Note | null>(null);
   const seq = useRef(0);
   useEffect(() => {
      let live = true;
      setNote(null);
      const load = () => {
         const mine = ++seq.current;
         api.readNote().then(
            (n) => live && mine === seq.current && setNote(n),
            (e) => console.error("read note failed", e),
         );
      };
      load();
      const off = api.noteChanged(load);
      return () => {
         live = false;
         void off.then((f) => f());
      };
   }, [api]);
   const set = useCallback((n: Note) => {
      seq.current++;
      setNote(n);
   }, []);
   return [note, set];
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
