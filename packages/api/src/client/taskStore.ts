// One Task list (ADR 0028) per window, shared by everything that shows it (sidebar, Tasks panel, All
// tasks view): one `ListTasks` load and one `TasksChanged` subscription while somebody is subscribed.
// Each `TasksChanged` carries the changed summaries, so the list is patched in place, not reloaded.

import type { TaskSummary } from "../generated";
import type { Transport, Unsubscribe } from "../transport/transport";
import { listTasks, tasksChanged } from "./tasks";

/** Where a `TaskStore` reads from. */
export type TaskStoreSource = {
   list: () => Promise<TaskSummary[]>;
   /** `tasks`: the current summaries of `ids` that still exist; an id without one was deleted. */
   onChanged: (onChange: (ids: string[], tasks: TaskSummary[]) => void) => Promise<Unsubscribe>;
};

export type TaskStore = {
   /** All Tasks, oldest first; null while loading. A stable array until it changes (for `useSyncExternalStore`). */
   peek(): TaskSummary[] | null;
   /** Loads and listens if first; the returned function stops both if last (the list is dropped). */
   subscribe(listener: () => void): () => void;
};

type Change = { ids: string[]; tasks: TaskSummary[] };

/** After a failed load, the one retry waits this long. */
export const TASK_RETRY_MS = 1000;

/** The number in a Task id (`t<n>`): the list's order. */
const num = (id: string) => Number(id.slice(1));

/** `list` with `change` applied: changed rows replaced, deleted ones dropped, new ones put in order. */
export function applyTaskChange(list: TaskSummary[], { ids, tasks }: Change): TaskSummary[] {
   const fresh = new Map(tasks.map((t) => [t.id, t]));
   const changed = new Set(ids);
   const next: TaskSummary[] = [];
   for (const t of list) {
      if (!changed.has(t.id)) next.push(t);
      else if (fresh.has(t.id)) {
         next.push(fresh.get(t.id) as TaskSummary);
         fresh.delete(t.id);
      }
   }
   if (fresh.size === 0) return next;
   next.push(...fresh.values());
   return next.sort((a, b) => num(a.id) - num(b.id));
}

export function createTaskStore(source: TaskStoreSource): TaskStore {
   let tasks: TaskSummary[] | null = null;
   const listeners = new Set<() => void>();
   let off: Promise<Unsubscribe> | null = null;
   /** Bumped by each load and by `stop`: a result from an older load is dropped. */
   let seq = 0;
   let loading = false;
   /** Changes seen while a load runs, applied on top of its result. */
   let queued: Change[] = [];
   let retry: ReturnType<typeof setTimeout> | undefined;

   const set = (next: TaskSummary[] | null) => {
      tasks = next;
      for (const l of [...listeners]) l();
   };

   /** `again`: on failure, try once more after `TASK_RETRY_MS`. */
   const load = (again = true) => {
      const mine = ++seq;
      loading = true;
      source.list().then(
         (list) => {
            if (mine !== seq) return;
            loading = false;
            const changes = queued;
            queued = [];
            set(changes.reduce(applyTaskChange, list));
         },
         (e) => {
            console.error("list tasks failed", e);
            if (mine !== seq) return;
            loading = false;
            // Older than any list loaded later: applied on top of one, they would undo newer rows.
            queued = [];
            // After the retry, the next TasksChanged loads again (see `changed`).
            if (again)
               retry = setTimeout(() => {
                  retry = undefined;
                  if (mine === seq) load(false);
               }, TASK_RETRY_MS);
         },
      );
   };

   const changed = (change: Change) => {
      // A late event after `stop` (the unsubscribe is async): nobody to load for.
      if (listeners.size === 0) return;
      if (loading) queued.push(change);
      // No list to patch (the load failed): load it again.
      else if (tasks === null) load();
      else set(applyTaskChange(tasks, change));
   };

   const start = () => {
      off = source.onChanged((ids, tasks) => changed({ ids, tasks }));
      load();
   };

   const stop = () => {
      void off?.then((f) => f());
      off = null;
      seq++;
      clearTimeout(retry);
      retry = undefined;
      loading = false;
      queued = [];
      tasks = null;
   };

   return {
      peek: () => tasks,
      subscribe(listener) {
         listeners.add(listener);
         if (listeners.size === 1) start();
         return () => {
            if (listeners.delete(listener) && listeners.size === 0) stop();
         };
      },
   };
}

const shared = new WeakMap<Transport, TaskStore>();

/** The window's store for `transport`: the same one for its life; it only loads while subscribed. */
export function taskStore(transport: Transport): TaskStore {
   let store = shared.get(transport);
   if (!store) {
      store = createTaskStore({
         list: () => listTasks(transport),
         onChanged: (f) => tasksChanged(transport, f),
      });
      shared.set(transport, store);
   }
   return store;
}
