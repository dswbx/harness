import { isOpen, type TaskPriority, type TaskStatus, type TaskSummary } from "@harness/api";

// Pure helpers for task lists (ADR 0028): sorting, grouping, the tasks of one Session.

/** Active work first, then what waits, then what is closed. */
const STATUS_RANK: Record<TaskStatus, number> = {
   in_progress: 0,
   in_review: 1,
   blocked: 2,
   todo: 3,
   backlog: 4,
   done: 5,
   cancelled: 6,
};

const PRIORITY_RANK: Record<TaskPriority, number> = {
   urgent: 0,
   high: 1,
   medium: 2,
   low: 3,
   none: 4,
};

type Sortable = Pick<TaskSummary, "status" | "priority" | "due" | "created_ms">;

/** Earliest first, none last. */
const byDue = (a: string | null, b: string | null) =>
   a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

/** By status, then priority (urgent first), then due date (earliest first, none last), then oldest first. */
export function compareTasks(a: Sortable, b: Sortable): number {
   return (
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      byDue(a.due, b.due) ||
      a.created_ms - b.created_ms
   );
}

/** A sorted copy (see `compareTasks`). */
export const sortTasks = <T extends Sortable>(tasks: readonly T[]): T[] =>
   [...tasks].sort(compareTasks);

/** Open tasks and closed ones (done or cancelled), each sorted. */
export function splitDone<T extends Sortable>(tasks: readonly T[]): { open: T[]; closed: T[] } {
   const sorted = sortTasks(tasks);
   return {
      open: sorted.filter((t) => isOpen(t.status)),
      closed: sorted.filter((t) => !isOpen(t.status)),
   };
}

/**
 * The tasks a Session's panel shows: `pinned`, the task the Session was last started from (null: none), and
 * `created`, the tasks created in it (without the pinned one).
 */
export function sessionTasks<T extends Pick<TaskSummary, "id" | "origin_session_id" | "sessions">>(
   tasks: readonly T[],
   sessionId: string,
): { pinned: T | null; created: T[] } {
   let pinned: T | null = null;
   let started = -1;
   for (const t of tasks)
      for (const l of t.sessions)
         if (l.session_id === sessionId && l.started_ms > started) {
            pinned = t;
            started = l.started_ms;
         }
   const created = tasks.filter((t) => t.origin_session_id === sessionId && t !== pinned);
   return { pinned, created };
}

/** The ids of every task below `id` (children, their children, ...). */
export function descendantIds(
   tasks: readonly Pick<TaskSummary, "id" | "parent_id">[],
   id: string,
): Set<string> {
   const out = new Set<string>();
   const queue = [id];
   for (let at = queue.pop(); at !== undefined; at = queue.pop())
      for (const t of tasks)
         if (t.parent_id === at && !out.has(t.id)) {
            out.add(t.id);
            queue.push(t.id);
         }
   return out;
}

/** The tasks `id` can move under: not itself, not one of its descendants; sorted. */
export function parentCandidates<T extends Sortable & Pick<TaskSummary, "id" | "parent_id">>(
   tasks: readonly T[],
   id: string,
): T[] {
   const below = descendantIds(tasks, id);
   return sortTasks(tasks.filter((t) => t.id !== id && !below.has(t.id)));
}

/** Its ancestors, top first (stops at a missing parent or a loop). */
export function ancestors<T extends Pick<TaskSummary, "id" | "parent_id">>(
   tasks: ReadonlyMap<string, T>,
   id: string,
): T[] {
   const out: T[] = [];
   const seen = new Set([id]);
   for (let p = tasks.get(id)?.parent_id; p && !seen.has(p); p = tasks.get(p)?.parent_id) {
      const t = tasks.get(p);
      if (!t) break;
      seen.add(p);
      out.unshift(t);
   }
   return out;
}

/** A selection as a new task: its first line is the title, the other lines (if any) the body. */
export function taskFromText(text: string): { title: string; body: string | null } | null {
   const lines = text.split("\n");
   const at = lines.findIndex((l) => l.trim() !== "");
   if (at < 0) return null;
   const title = (lines[at] ?? "").replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
   const body = lines
      .slice(at + 1)
      .join("\n")
      .trim();
   return { title, body: body || null };
}
