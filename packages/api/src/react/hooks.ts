import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionApi } from "../client/client";
import { type GitStatusSnapshot, gitStatusStore } from "../client/gitStatusStore";
import type { Event, Note, PrRefKey, SharedArtifactEntry, TaskSummary } from "../generated";
import { prKey } from "../github/prRefs";
import type { PrEntry, PrStore } from "../github/prStore";
import { onSessionForgotten } from "../platform/forgetSession";
import type { Unsubscribe } from "../transport/transport";

/** How many Sessions keep their folded state after their View unmounts. */
const FOLD_CACHE_SESSIONS = 5;
/** A folded state and the `seq` to load from next: always the fold of every Event below `next`. */
type Fold = { state: unknown; next: number };
/**
 * Folded state of recently shown Sessions, so switching back to one renders at once and loads only
 * what came since. Per Session (least recently used first), then per reducer: Views with different
 * reducers fold the same log to different states. Valid for the app's life: a Session Log is only
 * appended to and its `seq` never goes back while the core runs (log.rs), and the core runs as long
 * as this window. Dropped when the Session is forgotten (deleted).
 */
const folds = new Map<string, Map<unknown, Fold>>();
onSessionForgotten((id) => void folds.delete(id));

function readFold(sessionId: string, reducer: unknown): Fold | undefined {
   const bySession = folds.get(sessionId);
   const fold = bySession?.get(reducer);
   if (bySession && fold) {
      folds.delete(sessionId);
      folds.set(sessionId, bySession);
   }
   return fold;
}

/** Keeps the newest fold: a second View of the Session that is behind does not move it back. */
function writeFold(sessionId: string, reducer: unknown, fold: Fold) {
   const bySession = folds.get(sessionId) ?? new Map<unknown, Fold>();
   if ((bySession.get(reducer)?.next ?? -1) <= fold.next) bySession.set(reducer, fold);
   folds.delete(sessionId);
   folds.set(sessionId, bySession);
   for (const id of folds.keys()) {
      if (folds.size <= FOLD_CACHE_SESSIONS) break;
      folds.delete(id);
   }
}

/** Test hook: empties the fold cache. */
export function clearFoldCache() {
   folds.clear();
}

/** How far a View has loaded its Session Log: Events below `next` are folded; it is whole once `next >= end`. */
export type LogLoad = { next: number; end: number };

/**
 * Loads the Session Log once per `api` (StrictMode-safe) and folds every Event through a pure
 * reducer, then stays live; unsubscribes on unmount. The log comes in pages up to the `end` of the
 * first one (ADR 0029), each folded as it lands, one asked for after the other, so an unmount stops
 * the load. Live Events come from a subscription that starts at that `end`: held until the last
 * page is folded, then folded on top, so there is no gap and no duplicate. The first render waits
 * for the whole log (a part of it would render a Turn without its end as running, and rows would
 * shift as the rest lands); after that, live Events are batched per animation frame. Once
 * subscribed, it asks the core to warm the Agent up so config options (models, modes) arrive before
 * the first prompt. The fold of a recently shown Session is kept (see `folds`): mounted again, it
 * renders that fold at once and loads only from its `next`.
 */
export function useSessionEvents<S>(
   api: SessionApi,
   reducer: (state: S, e: Event) => S,
   init: () => S,
   /** Folds many Events at once; defaults to folding `reducer` one by one. Must equal that fold. */
   batchReducer?: (state: S, events: readonly Event[]) => S,
   /** Called after each page and once the log is whole: for a loading indicator. Read when `api` changes, like `reducer`. */
   onLoad?: (load: LogLoad) => void,
): S {
   const [state, setState] = useState<S>(
      () => (readFold(api.sessionId, reducer)?.state as S | undefined) ?? init(),
   );
   // biome-ignore lint/correctness/useExhaustiveDependencies: reducer, init, batchReducer and onLoad are read once per `api` (stable module-level functions).
   useEffect(() => {
      const sessionId = api.sessionId;
      const cached = readFold(sessionId, reducer);
      // This View's own fold: the fold of every Event below `next`. Written to the cache only
      // once the log is whole, so a later mount never takes a part for the whole.
      let folded = (cached?.state as S | undefined) ?? init();
      let next = cached?.next ?? 0;
      let cancelled = false;
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
         writeFold(sessionId, reducer, { state: folded, next });
         const shown = folded;
         setState(() => shown);
      };
      const flush = () => {
         raf = 0;
         if (cancelled || pending.length === 0) return;
         const batch = pending;
         pending = [];
         fold(batch);
         show();
      };
      const load = async () => {
         let page = await api.readLogPage(next);
         if (cancelled) return;
         const end = page.end;
         api.subscribe((e) => {
            if (cancelled) return;
            pending.push(e);
            if (loaded && !raf) raf = requestAnimationFrame(flush);
         }, end)
            .then((u) => {
               if (cancelled) u();
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
            page = await api.readLogPage(next, end);
            if (cancelled) return;
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
      load().catch((err) => console.error("loading the Session Log failed", err));
      return () => {
         cancelled = true;
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
