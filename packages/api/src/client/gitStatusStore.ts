// One git status store per Session, shared by everything that shows it (header, Changes, Files). Built like
// `prStore`: polls only while somebody is subscribed, with one timer and one focus handler per Session.

import type { GitStatus } from "../generated";
import type { SessionApi } from "./session";

export type GitStatusSnapshot = {
   /** Whether the folder is a git repository; null until known. */
   isRepo: boolean | null;
   /** The last status loaded; kept when a later load fails. */
   status: GitStatus | null;
   /** The last load's error, cleared by the next success. */
   error: string | null;
   /** Goes up each time a loaded status differs from the last one, so views can reload what they show. */
   changes: number;
};

export type GitStatusSubscribeOptions = {
   /** Needs `status` (default), not just `isRepo`: a repo is only polled for status while somebody does. */
   status?: boolean;
};

export type GitStatusStore = {
   /** The current snapshot; a stable object until it changes (for `useSyncExternalStore`). */
   peek(): GitStatusSnapshot;
   /** Starts polling if first; the returned function stops it if last. Loads right away. */
   subscribe(listener: () => void, opts?: GitStatusSubscribeOptions): () => void;
   /** Loads now; a load already in flight is shared. Resolves when it finished (never rejects). */
   refresh(): Promise<void>;
};

/** The Workspace changes behind the Agent's back too (an editor, a terminal): look every 20s while visible. */
export const GIT_POLL_MS = 20_000;

/** Branch, upstream counts and the changed files: what a reload would show differently. */
export const gitFingerprint = (s: GitStatus) =>
   `${s.branch}|${s.ahead}|${s.behind}|${s.files.map((f) => `${f.status}${f.path}+${f.additions}-${f.deletions}`).join(",")}`;

type StoreApi = Pick<SessionApi, "sessionId" | "gitStatus" | "workspace">;

export function createGitStatusStore(
   api: StoreApi,
   { interval = GIT_POLL_MS, onIdle }: { interval?: number; onIdle?: () => void } = {},
): GitStatusStore {
   let snap: GitStatusSnapshot = { isRepo: null, status: null, error: null, changes: 0 };
   let seen: string | null = null;
   const listeners = new Map<() => void, boolean>();
   let wantStatus = 0;
   let timer: ReturnType<typeof setInterval> | null = null;
   let inflight: Promise<void> | null = null;
   /** Drops a load that was in flight when the last subscriber left. */
   let epoch = 0;

   const set = (patch: Partial<GitStatusSnapshot>) => {
      snap = { ...snap, ...patch };
      for (const l of [...listeners.keys()]) l();
   };

   async function load(mine: number) {
      // Not known to be a repository yet (`git init` can happen later): ask the Workspace.
      if (snap.isRepo !== true) {
         try {
            const w = await api.workspace();
            if (mine !== epoch) return;
            const isRepo = !!w?.repo_root;
            if (isRepo !== snap.isRepo) set({ isRepo });
            if (!isRepo) return;
         } catch {
            return;
         }
      }
      if (wantStatus === 0) return;
      try {
         const s = await api.gitStatus();
         if (mine !== epoch) return;
         const f = gitFingerprint(s);
         const changed = seen !== null && f !== seen;
         seen = f;
         set({ status: s, error: null, changes: snap.changes + (changed ? 1 : 0) });
      } catch (e) {
         if (mine === epoch) set({ error: e instanceof Error ? e.message : String(e) });
      }
   }

   const refresh = () => {
      if (!inflight) {
         const mine = epoch;
         inflight = load(mine).finally(() => {
            inflight = null;
         });
      }
      return inflight;
   };

   const check = () => {
      if (!document.hidden) void refresh();
   };

   function start() {
      timer = setInterval(check, interval);
      window.addEventListener("focus", check);
      document.addEventListener("visibilitychange", check);
   }
   function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      epoch++;
      inflight = null;
   }

   return {
      peek: () => snap,
      subscribe(listener, { status = true } = {}) {
         listeners.set(listener, status);
         if (status) wantStatus++;
         if (listeners.size === 1) start();
         void refresh();
         let done = false;
         return () => {
            if (done) return;
            done = true;
            listeners.delete(listener);
            if (status) wantStatus--;
            if (listeners.size === 0) {
               stop();
               onIdle?.();
            }
         };
      },
      refresh,
   };
}

const shared = new Map<string, GitStatusStore>();

/** The Session's shared store; it is dropped once nobody is subscribed. */
export function gitStatusStore(api: StoreApi): GitStatusStore {
   let store = shared.get(api.sessionId);
   if (!store) {
      const created: GitStatusStore = createGitStatusStore(api, {
         onIdle: () => {
            if (shared.get(api.sessionId) === created) shared.delete(api.sessionId);
         },
      });
      store = created;
      shared.set(api.sessionId, store);
   }
   return store;
}
