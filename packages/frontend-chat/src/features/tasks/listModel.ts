import {
   isOpen,
   TASK_STATUS_LABEL,
   type TaskPriority,
   type TaskStatus,
   type TaskSummary,
} from "@harness/api";
import type { GraphGroupBy } from "./graphLayout";

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

const STATUS_COUNT = Object.keys(STATUS_RANK).length;

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

// The All tasks view (ADR 0028): filters, groups and the rows of its list.

/** `open`: open tasks, the closed ones in a folded group at the end; `all`; `done`: closed tasks only. */
export type StatusFilter = "open" | "all" | "done";
/** `today`: due today or before. `week`: due in the next 7 days or before. `none`: no due date. */
export type DueFilter = "any" | "overdue" | "today" | "week" | "none";

/** The `session` filter value for tasks created outside a Session. */
export const NO_SESSION = "none";

export type TaskFilter = {
   status: StatusFilter;
   /** Empty: any. */
   priorities: readonly TaskPriority[];
   /** The origin Session; `NO_SESSION`: created outside one; null: any. */
   session: string | null;
   due: DueFilter;
   /** Only tasks with an upstream link. */
   upstream: boolean;
   /** Text in the title, or the task id. */
   query: string;
};

export const DEFAULT_FILTER: TaskFilter = {
   status: "open",
   priorities: [],
   session: null,
   due: "any",
   upstream: false,
   query: "",
};

/** Any filter other than the status one is set. */
export const hasFilters = (f: TaskFilter): boolean =>
   f.priorities.length > 0 ||
   f.session !== null ||
   f.due !== "any" ||
   f.upstream ||
   f.query.trim() !== "";

type Filterable = Pick<
   TaskSummary,
   "id" | "title" | "status" | "priority" | "due" | "upstream" | "origin_session_id"
>;

/** `YYYY-MM-DD` plus `n` days. */
function addDays(day: string, n: number): string {
   const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
   const at = new Date(y, m - 1, d + n);
   const p = (x: number) => String(x).padStart(2, "0");
   return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** Whether the task passes every filter but the status one. `today`: `YYYY-MM-DD`. */
export function matchesFilter(t: Filterable, f: TaskFilter, today: string): boolean {
   if (f.priorities.length > 0 && !f.priorities.includes(t.priority)) return false;
   if (f.session !== null && (t.origin_session_id ?? NO_SESSION) !== f.session) return false;
   if (f.upstream && !t.upstream) return false;
   const due = t.due;
   if (f.due === "overdue" && !(due !== null && due < today)) return false;
   if (f.due === "today" && !(due !== null && due <= today)) return false;
   if (f.due === "week" && !(due !== null && due <= addDays(today, 7))) return false;
   if (f.due === "none" && due !== null) return false;
   const q = f.query.trim().toLowerCase();
   return !q || t.title.toLowerCase().includes(q) || t.id.toLowerCase() === q;
}

const statusPasses = (status: TaskStatus, f: StatusFilter) =>
   f === "all" || (f === "open") === isOpen(status);

/** Whether the task passes every filter, the status one too (the Graph view shows only these). */
export const passesFilter = (t: Filterable, f: TaskFilter, today: string): boolean =>
   statusPasses(t.status, f.status) && matchesFilter(t, f, today);

/** A field, or a prop key as `prop:<key>` (ADR 0029). One string, so it fits a menu value and a stored value. */
export type GroupBy = "topic" | "status" | "session" | `prop:${string}`;

/** The prop key `g` groups by (null: a field). */
export const groupProp = (g: GroupBy): string | null => (g.startsWith("prop:") ? g.slice(5) : null);

/** A stored group-by; anything else (an old or broken value) is `fallback`. */
export function parseGroupBy(raw: string | null, fallback: GroupBy = "topic"): GroupBy {
   if (raw === "topic" || raw === "status" || raw === "session") return raw;
   return raw && /^prop:[a-z0-9_-]{1,32}$/.test(raw) ? (raw as GroupBy) : fallback;
}

type Listable = Filterable &
   Pick<TaskSummary, "parent_id" | "created_ms" | "origin_title" | "props">;

/** One row of the list. */
export type ListRow<T> = {
   task: T;
   /** 0: a topic (or a row of a flat group); 1: its subtask; ... */
   depth: number;
   /** Its subtasks, shown or not. */
   kids: number;
   /** Its subtasks show. */
   expanded: boolean;
   /** It did not pass the filters: it shows only for the subtasks that did. */
   context: boolean;
};

/** A group of rows. By topic, `head` is the topic's own row (null: the "No topic" group). */
export type ListGroup<T> = {
   key: string;
   label: string;
   head: ListRow<T> | null;
   rows: ListRow<T>[];
   /** The rows hide (the group, or its topic, is folded). */
   folded: boolean;
   /** Tasks in it that passed the filters (also when folded). */
   count: number;
};

export type TaskList<T> = {
   groups: ListGroup<T>[];
   /** With the `open` status filter: the closed tasks that passed the other filters (shown last, folded). */
   closed: T[];
};

/** The group key of the tasks without a topic, Session, status or prop value. */
export const NONE_GROUP = "none";

/**
 * Whether the row (task id) or group (`group:<key>`) shows its contents: topics and groups do by default,
 * subtasks with subtasks do not. `flipped` holds the ids the user turned the other way.
 */
export const isExpanded = (key: string, depth: number, flipped: ReadonlySet<string>): boolean =>
   (depth === 0) !== flipped.has(key);

/**
 * The list of the All tasks view. By topic: one group per topic (a top-level task with subtasks) with its
 * subtasks below, indented, then "No topic" with the top-level tasks without subtasks. A task that fails the
 * filters still shows when one of its subtasks passes. By status, Session or a prop key: flat groups. By a prop
 * key, one group per value (key `=<value>`), sorted by name, then "No <key>" for the tasks without it.
 */
export function buildList<T extends Listable>(
   tasks: readonly T[],
   o: {
      filter: TaskFilter;
      groupBy: GroupBy;
      today: string;
      flipped: ReadonlySet<string>;
      /** A Session's title (null: not known), for the Session groups. */
      sessionTitle?: (id: string) => string | null;
   },
): TaskList<T> {
   const { filter, flipped } = o;
   const rest = (t: T) => matchesFilter(t, filter, o.today);
   const passes = (t: T) => statusPasses(t.status, filter.status) && rest(t);
   const ids = new Set(tasks.map((t) => t.id));
   const kidsOf = new Map<string | null, T[]>();
   for (const t of tasks) {
      const p = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null;
      const l = kidsOf.get(p);
      if (l) l.push(t);
      else kidsOf.set(p, [t]);
   }
   for (const [k, l] of kidsOf) kidsOf.set(k, sortTasks(l));
   const kids = (id: string) => kidsOf.get(id) ?? [];
   // Shown: it passes, or a subtask below it does.
   const shownMemo = new Map<string, boolean>();
   const shown = (t: T, seen = new Set<string>()): boolean => {
      const hit = shownMemo.get(t.id);
      if (hit !== undefined) return hit;
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      const v = passes(t) || kids(t.id).some((k) => shown(k, seen));
      shownMemo.set(t.id, v);
      return v;
   };
   const row = (t: T, depth: number): ListRow<T> => ({
      task: t,
      depth,
      kids: kids(t.id).length,
      expanded: isExpanded(t.id, depth, flipped),
      context: !passes(t),
   });
   // With the `open` filter, the closed tasks that passed the other filters and show nowhere else.
   const closedOf = (elsewhere: (t: T) => boolean) =>
      filter.status === "open"
         ? sortTasks(tasks.filter((t) => !isOpen(t.status) && rest(t) && !elsewhere(t)))
         : [];

   if (o.groupBy !== "topic") {
      // Flat groups take only the tasks that pass: a closed task with open subtasks goes here too.
      const closed = closedOf(() => false);
      const prop = groupProp(o.groupBy);
      const keyOf = (t: T) => {
         if (prop !== null) {
            // Own keys only: a key such as `constructor` is a valid prop key.
            return Object.hasOwn(t.props, prop) ? `=${t.props[prop]}` : NONE_GROUP;
         }
         return o.groupBy === "status" ? t.status : (t.origin_session_id ?? NONE_GROUP);
      };
      const byKey = new Map<string, T[]>();
      for (const t of sortTasks(tasks.filter(passes))) {
         const l = byKey.get(keyOf(t));
         if (l) l.push(t);
         else byKey.set(keyOf(t), [t]);
      }
      const label = (key: string, first: T) =>
         o.groupBy === "status"
            ? key
            : prop !== null
              ? key === NONE_GROUP
                 ? `No ${prop}`
                 : key.slice(1)
              : key === NONE_GROUP
                ? "No session"
                : (o.sessionTitle?.(key) ?? first.origin_title ?? "Session");
      const groups = [...byKey].map(([key, list]): ListGroup<T> => {
         const folded = !isExpanded(`group:${key}`, 0, flipped);
         return {
            key,
            label: label(key, list[0] as T),
            head: null,
            rows: folded ? [] : list.map((t) => ({ ...row(t, 0), expanded: false })),
            folded,
            count: list.length,
         };
      });
      // Statuses come in their order (sortTasks); Sessions and prop values by name, "No ..." last.
      if (o.groupBy !== "status")
         groups.sort(
            (a, b) =>
               Number(a.key === NONE_GROUP) - Number(b.key === NONE_GROUP) ||
               a.label.localeCompare(b.label),
         );
      return { groups, closed };
   }

   // By topic, a closed task with open subtasks shows as their context row.
   const closed = closedOf(shown);
   const groups: ListGroup<T>[] = [];
   const loose: T[] = [];
   for (const top of kidsOf.get(null) ?? []) {
      if (!shown(top)) continue;
      if (kids(top.id).length === 0) {
         loose.push(top);
         continue;
      }
      const rows: ListRow<T>[] = [];
      let count = 0;
      const walk = (parent: string, depth: number, seen: Set<string>) => {
         for (const k of kids(parent)) {
            if (!shown(k) || seen.has(k.id)) continue;
            seen.add(k.id);
            if (passes(k)) count++;
            const r = row(k, depth);
            rows.push(r);
            if (r.expanded) walk(k.id, depth + 1, seen);
            else countBelow(k.id, seen);
         }
      };
      const countBelow = (parent: string, seen: Set<string>) => {
         for (const k of kids(parent)) {
            if (seen.has(k.id)) continue;
            seen.add(k.id);
            if (passes(k)) count++;
            countBelow(k.id, seen);
         }
      };
      const head = row(top, 0);
      const seen = new Set([top.id]);
      if (head.expanded) walk(top.id, 1, seen);
      else countBelow(top.id, seen);
      groups.push({
         key: top.id,
         label: top.title,
         head,
         rows,
         folded: !head.expanded,
         count,
      });
   }
   if (loose.length > 0) {
      const folded = !isExpanded(`group:${NONE_GROUP}`, 0, flipped);
      groups.push({
         key: NONE_GROUP,
         label: "No topic",
         head: null,
         rows: folded ? [] : loose.map((t) => row(t, 0)),
         folded,
         count: loose.length,
      });
   }
   return { groups, closed };
}

/**
 * The lanes of the Graph view for a group-by, with the List view's group labels: by topic, a task's topic is its
 * top-level ancestor when that one has subtasks (a top-level task without subtasks: "No topic"); by status, the
 * status, in the status order (in progress first); by Session, the origin Session; a prop key goes to `layoutGraph`
 * as it is. `tasks`: all tasks (topic titles and parents).
 */
export function graphGroup<T extends Pick<TaskSummary, "id" | "parent_id" | "title" | "status">>(
   tasks: readonly T[],
   groupBy: GroupBy,
   sessionTitle: (id: string) => string,
): GraphGroupBy<T & Pick<TaskSummary, "origin_session_id">> {
   const prop = groupProp(groupBy);
   if (prop !== null) return prop;
   if (groupBy === "status")
      return {
         laneOf: (t) => t.status,
         label: (k) => TASK_STATUS_LABEL[k as TaskStatus] ?? k,
         missing: "No status",
         rank: (k) => STATUS_RANK[k as TaskStatus] ?? STATUS_COUNT,
      };
   if (groupBy === "session")
      return { laneOf: (t) => t.origin_session_id, label: sessionTitle, missing: "No session" };
   const byId = new Map(tasks.map((t) => [t.id, t]));
   const parents = new Set(tasks.map((t) => t.parent_id));
   return {
      laneOf: (t) => {
         const top = ancestors(byId, t.id)[0] ?? t;
         return parents.has(top.id) ? top.id : null;
      },
      label: (id) => byId.get(id)?.title ?? id,
      missing: "No topic",
   };
}

type Sectionable = Sortable &
   Pick<TaskSummary, "id" | "parent_id" | "title" | "origin_session_id" | "props">;

/**
 * `tasks` (sorted) in sections for a group-by, with the graph's lane keys and labels (`graphGroup`): a prop value,
 * the topic, the Session, the status. Ordered like the All tasks list: statuses in their order, topics in task
 * order, the others by name; the tasks without a key ("No <key>") last. `all`: all tasks (topic titles, parents).
 */
export function groupSections<T extends Sectionable>(
   tasks: readonly T[],
   all: readonly T[],
   groupBy: GroupBy,
   sessionTitle: (id: string) => string,
): { key: string; label: string; tasks: T[] }[] {
   // Keys: `=<lane key>`, or `NONE_GROUP` for the tasks without one.
   const g = graphGroup(all, groupBy, sessionTitle);
   const keyOf = (t: T): string | null => {
      const k =
         g === null
            ? null
            : typeof g === "string"
              ? Object.hasOwn(t.props, g)
                 ? t.props[g]
                 : undefined
              : g.laneOf(t);
      return k === undefined || k === "" ? null : k;
   };
   const labelOf = (k: string | null) =>
      typeof g === "string"
         ? (k ?? `No ${g}`)
         : g === null
           ? ""
           : k === null
             ? g.missing
             : (g.label?.(k) ?? k);
   const byKey = new Map<string | null, T[]>();
   for (const t of tasks) {
      const k = keyOf(t);
      const l = byKey.get(k);
      if (l) l.push(t);
      else byKey.set(k, [t]);
   }
   const byId = new Map(all.map((t) => [t.id, t]));
   const order = (a: string, b: string): number => {
      if (groupBy === "status") return STATUS_RANK[a as TaskStatus] - STATUS_RANK[b as TaskStatus];
      const ta = byId.get(a);
      const tb = byId.get(b);
      if (groupBy === "topic" && ta && tb) return compareTasks(ta, tb);
      return labelOf(a).localeCompare(labelOf(b));
   };
   return [...byKey]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : order(a, b)))
      .map(([k, list]) => ({
         key: k === null ? NONE_GROUP : `=${k}`,
         label: labelOf(k),
         tasks: list,
      }));
}

/** How many different values the prop `key` has among `tasks`. */
export const propValueCount = (tasks: readonly Pick<TaskSummary, "props">[], key: string): number =>
   new Set(tasks.flatMap((t) => (Object.hasOwn(t.props, key) ? [t.props[key]] : []))).size;

/**
 * The topics `id` can move under from the row menu: top-level tasks with subtasks, not the task itself, not
 * one below it and not its parent now; sorted.
 */
export function moveTargets<T extends Sortable & Pick<TaskSummary, "id" | "parent_id">>(
   tasks: readonly T[],
   id: string,
): T[] {
   const self = tasks.find((t) => t.id === id);
   const below = descendantIds(tasks, id);
   const parents = new Set(tasks.map((t) => t.parent_id));
   return sortTasks(
      tasks.filter(
         (t) =>
            t.parent_id === null &&
            parents.has(t.id) &&
            t.id !== id &&
            t.id !== self?.parent_id &&
            !below.has(t.id),
      ),
   );
}

/** Whether `id` can be dropped on `target` (null: the top level): a move that changes something and makes no loop. */
export function canNest(
   tasks: readonly Pick<TaskSummary, "id" | "parent_id">[],
   id: string,
   target: string | null,
): boolean {
   const self = tasks.find((t) => t.id === id);
   if (!self || self.parent_id === target) return false;
   return target === null || (target !== id && !descendantIds(tasks, id).has(target));
}

/**
 * The tasks of `selected`'s ancestors that must be expanded to show its row, as `flipped` after (the same
 * set when nothing changes).
 */
export function reveal(
   tasks: ReadonlyMap<string, Pick<TaskSummary, "id" | "parent_id">>,
   id: string,
   flipped: ReadonlySet<string>,
): ReadonlySet<string> {
   const up = ancestors(tasks, id);
   let next: Set<string> | null = null;
   up.forEach((t, depth) => {
      if (isExpanded(t.id, depth, flipped)) return;
      next ??= new Set(flipped);
      if (depth === 0) next.delete(t.id);
      else next.add(t.id);
   });
   return next ?? flipped;
}

/** How many Sessions the open tasks come from or were started in. */
export function sessionCount(
   tasks: readonly Pick<TaskSummary, "status" | "origin_session_id" | "sessions">[],
): number {
   const ids = new Set<string>();
   for (const t of tasks) {
      if (!isOpen(t.status)) continue;
      if (t.origin_session_id) ids.add(t.origin_session_id);
      for (const l of t.sessions) ids.add(l.session_id);
   }
   return ids.size;
}
