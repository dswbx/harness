// One git status store per Session, shared by everything that shows it (header, Changes, Files). Built like
// `prStore`: polls only while somebody is subscribed, with one timer and one focus handler per Session.

import { errText } from "../errors";
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
   /**
    * Loads now, looking at whether the folder is still a repository too. One asked while a load runs
    * waits for it and runs once more (so it shows changes made since); several share that one.
    * Resolves when it finished (never rejects).
    */
   refresh(): Promise<void>;
   /** Resolves once the load running or queued now has finished. */
   settled(): Promise<void>;
};

/** The Workspace changes behind the Agent's back too (an editor, a terminal): look every 20s while visible. */
export const GIT_POLL_MS = 20_000;

/** Branch, upstream counts and the changed files: what a reload would show differently. */
export const gitFingerprint = (s: GitStatus) =>
   `${s.branch}|${s.ahead}|${s.behind}|${s.files.map((f) => `${f.status}${f.path}+${f.additions}-${f.deletions}`).join(",")}`;

type StoreApi = Pick<SessionApi, "sessionId" | "gitStatus" | "workspace">;

export function createGitStatusStore(
   api: StoreApi,
   { interval = GIT_POLL_MS }: { interval?: number } = {},
): GitStatusStore {
   let snap: GitStatusSnapshot = { isRepo: null, status: null, error: null, changes: 0 };
   let seen: string | null = null;
   const listeners = new Map<() => void, boolean>();
   let wantStatus = 0;
   let timer: ReturnType<typeof setInterval> | null = null;
   let running: Promise<void> | null = null;
   /** The one follow-up load for refreshes asked while `running`, and whether one of them wants a repo recheck. */
   let queued: Promise<void> | null = null;
   let queuedRecheck = false;
   /** Bumped by each load and by `stop`: a result from an older load is dropped. */
   let gen = 0;
   /** Bumped by `stop`: a follow-up queued before it is dropped. */
   let epoch = 0;

   const set = (patch: Partial<GitStatusSnapshot>) => {
      snap = { ...snap, ...patch };
      for (const l of [...listeners.keys()]) l();
   };

   /** Reads whether the folder is a repository; false means it no longer is (or never was). */
   async function checkRepo(mine: number): Promise<boolean | null> {
      try {
         const w = await api.workspace();
         if (mine !== gen) return null;
         const isRepo = !!w?.repo_root;
         if (isRepo !== snap.isRepo) {
            seen = isRepo ? seen : null;
            set(isRepo ? { isRepo } : { isRepo, status: null, error: null });
         }
         return isRepo;
      } catch {
         return null;
      }
   }

   async function load(mine: number, recheck: boolean) {
      // Not known to be a repository yet (`git init` can happen later), or asked to look again.
      if (recheck || snap.isRepo !== true) {
         const isRepo = await checkRepo(mine);
         if (mine !== gen) return;
         // A failed lookup keeps what is known.
         if (isRepo === false || (isRepo === null && snap.isRepo !== true)) return;
      }
      if (wantStatus === 0) return;
      try {
         const s = await api.gitStatus();
         if (mine !== gen) return;
         const f = gitFingerprint(s);
         const changed = seen !== null && f !== seen;
         seen = f;
         set({ status: s, error: null, changes: snap.changes + (changed ? 1 : 0) });
      } catch (e) {
         if (mine !== gen) return;
         set({ error: errText(e) });
         // Maybe the repository is gone.
         await checkRepo(mine);
      }
   }

   /** Whether `running` has begun loading (callers before that share it). */
   let started = false;
   let pendingRecheck = false;

   function begin(recheck: boolean): Promise<void> {
      started = false;
      pendingRecheck = recheck;
      const p: Promise<void> = Promise.resolve()
         .then(() => {
            started = true;
            return load(++gen, pendingRecheck);
         })
         .finally(() => {
            if (running === p) running = null;
         });
      running = p;
      return p;
   }

   /** A load that starts after the current one, so a refresh asked mid-load shows what changed since. */
   function run(recheck: boolean): Promise<void> {
      if (!running) return begin(recheck);
      if (!started) {
         pendingRecheck ||= recheck;
         return running;
      }
      queuedRecheck ||= recheck;
      const e = epoch;
      queued ??= running.then(() => {
         if (e !== epoch) return;
         const re = queuedRecheck;
         queued = null;
         queuedRecheck = false;
         return begin(re);
      });
      return queued;
   }

   const check = () => {
      if (!document.hidden) void run(false);
   };

   function start() {
      seen = null;
      timer = setInterval(check, interval);
      window.addEventListener("focus", check);
      document.addEventListener("visibilitychange", check);
   }
   function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
      gen++;
      epoch++;
      running = null;
      queued = null;
      queuedRecheck = false;
   }

   return {
      peek: () => snap,
      subscribe(listener, { status = true } = {}) {
         listeners.set(listener, status);
         if (status) wantStatus++;
         if (listeners.size === 1) start();
         void run(false);
         let done = false;
         return () => {
            if (done) return;
            done = true;
            listeners.delete(listener);
            if (status) wantStatus--;
            if (listeners.size === 0) stop();
         };
      },
      refresh: () => run(true),
      settled: () => (queued ?? running ?? Promise.resolve()).then(() => {}),
   };
}

const shared = new Map<string, GitStatusStore>();

/** The Session's store, the same one for the life of the app: it only polls while subscribed. */
export function gitStatusStore(api: StoreApi): GitStatusStore {
   let store = shared.get(api.sessionId);
   if (!store) {
      store = createGitStatusStore(api);
      shared.set(api.sessionId, store);
   }
   return store;
}
