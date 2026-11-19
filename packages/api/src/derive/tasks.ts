import type { TaskPriority, TaskStatus, TaskSummary } from "../generated";

// Pure helpers over the Task list (ADR 0028), shared by the sidebar and Frontends (ADR 0012).

/** Each status as the user reads it, in menu order. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
   backlog: "Backlog",
   todo: "Todo",
   in_progress: "In progress",
   in_review: "In review",
   blocked: "Blocked",
   done: "Done",
   cancelled: "Cancelled",
};

const STATUSES = new Set<unknown>(Object.keys(TASK_STATUS_LABEL));
const PRIORITIES = new Set<unknown>([
   "none",
   "low",
   "medium",
   "high",
   "urgent",
] satisfies TaskPriority[]);

/** Whether `v` is a status value (for parsing tool input and output). */
export const isTaskStatus = (v: unknown): v is TaskStatus => STATUSES.has(v);
export const isTaskPriority = (v: unknown): v is TaskPriority => PRIORITIES.has(v);

/** Not done and not cancelled. */
export function isOpen(status: TaskStatus): boolean {
   return status !== "done" && status !== "cancelled";
}

/** How many Tasks are open. */
export function openCount(tasks: readonly Pick<TaskSummary, "status">[]): number {
   return tasks.filter((t) => isOpen(t.status)).length;
}

/** A due date (`YYYY-MM-DD`) before `today` (`YYYY-MM-DD`, see `localDay`). */
export function isOverdue(due: string | null, today: string): boolean {
   return due !== null && due < today;
}

/** How many open Tasks are due today or overdue. */
export function dueCount(
   tasks: readonly Pick<TaskSummary, "status" | "due">[],
   today: string,
): number {
   return tasks.filter((t) => isOpen(t.status) && t.due !== null && t.due <= today).length;
}

/** The direct children of `parentId` (null: the top level), by `order`. */
export function childrenOf<T extends Pick<TaskSummary, "parent_id" | "order">>(
   tasks: readonly T[],
   parentId: string | null,
): T[] {
   return tasks.filter((t) => t.parent_id === parentId).sort((a, b) => a.order - b.order);
}

/** Done and total direct children of a topic (a Task with children); cancelled ones do not count. */
export function topicProgress(
   tasks: readonly Pick<TaskSummary, "parent_id" | "status">[],
   id: string,
): { done: number; total: number } {
   const kids = tasks.filter((t) => t.parent_id === id && t.status !== "cancelled");
   return { done: kids.filter((t) => t.status === "done").length, total: kids.length };
}

/** A short id for an upstream link: Linear `ABC-123`, GitHub `#123`; null for other links. */
export function upstreamId(url: string): string | null {
   const linear = /^https?:\/\/linear\.app\/[^/]+\/issue\/([a-z][a-z0-9]*-\d+)(?:[/?#]|$)/i.exec(
      url,
   );
   if (linear?.[1]) return linear[1].toUpperCase();
   const github = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/.exec(
      url,
   );
   if (github?.[1]) return `#${github[1]}`;
   return null;
}

/**
 * An upstream link as the core takes it: `http://` or `https://`, with `https://` added when no
 * scheme is given (`linear.app/x` -> `https://linear.app/x`). Null for another scheme
 * (`javascript:`, `file:`), an empty host or spaces.
 */
export function webLink(input: string): string | null {
   const url = input.trim();
   if (!url) return null;
   const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
   // `localhost:3000/x` has no scheme: a number after the colon is a port.
   const scheme = m && !/^\d/.test(url.slice(m[0].length)) ? m[1]?.toLowerCase() : null;
   const full = scheme ? url : `https://${url}`;
   if (scheme && scheme !== "http" && scheme !== "https") return null;
   const rest = full.replace(/^https?:\/\//i, "");
   if (rest === full || !rest.replace(/^\/+/, "") || /\s/.test(rest)) return null;
   return full;
}

/** A local date as `YYYY-MM-DD`, the format of `due`. */
export function localDay(d: Date = new Date()): string {
   const p = (n: number) => String(n).padStart(2, "0");
   return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
