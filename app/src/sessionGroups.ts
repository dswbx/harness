import type { SessionStatus, SessionSummary, WorkspaceInfo } from "@harness/api";
import { QUICK_TITLE } from "./composer";

/** Sidebar Session list: search, sort, group and the detail row's labels (pure, see `SessionList.tsx`). */

export type SortBy = "recent" | "created";
export type Display = "condensed" | "detail";
export type GroupBy = "none" | "folder" | "date";
export type ViewOptions = { sort: SortBy; display: Display; group: GroupBy };

export const DEFAULT_VIEW: ViewOptions = { sort: "recent", display: "detail", group: "folder" };

/** How many view options differ from the defaults (highlights the options button). */
export const viewChanges = (v: ViewOptions) =>
   (Object.keys(DEFAULT_VIEW) as (keyof ViewOptions)[]).filter((k) => v[k] !== DEFAULT_VIEW[k])
      .length;

/** Top-level folder name: "/Users/me/harness/" -> "harness". */
export const folderName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** The branch to show: the folder's current branch, else the Worktree's own. */
export const branchOf = (ws: WorkspaceInfo) => ws.branch ?? ws.worktree_branch;

/** `q` lowercased and trimmed; matches title, folder name, branch and "#<pr>". */
export function matches(s: SessionSummary, q: string): boolean {
   if (!q) return true;
   const ws = s.workspace;
   return [
      s.title,
      s.quick ? "quick" : folderName(s.folder),
      branchOf(ws) ?? "",
      ws.pr != null ? `#${ws.pr}` : "",
   ].some((t) => t.toLowerCase().includes(q));
}

/** `title` split around the first case-insensitive match of `q`, or null without one. */
export function highlight(title: string, q: string): [string, string, string] | null {
   const i = q ? title.toLowerCase().indexOf(q) : -1;
   return i < 0
      ? null
      : [title.slice(0, i), title.slice(i, i + q.length), title.slice(i + q.length)];
}

/**
 * Without Quick Sessions nobody has written in yet (e.g. the Quick overlay's draft, ADR 0022),
 * except `selected`: this window started it and shows it.
 */
export const hideUnusedQuick = (list: SessionSummary[], selected: string | null) =>
   list.filter((s) => !s.quick || s.title !== QUICK_TITLE || s.id === selected);

/** Sub Sessions by their parent's id. */
export type Children = Map<string, SessionSummary[]>;
export type Nested = { roots: SessionSummary[]; children: Children };

/**
 * Sub Sessions under their parent. A Sub Session whose parent is not in `list` (archived, deleted)
 * is a root. With a search `q`, a root shows when it or one of its children matches; a parent that
 * does not match itself keeps only its matching children.
 */
export function nestSubSessions(list: SessionSummary[], q = ""): Nested {
   const ids = new Set(list.map((s) => s.id));
   const all: Children = new Map();
   const roots: SessionSummary[] = [];
   for (const s of list) {
      const p = s.parent?.session_id;
      if (p && p !== s.id && ids.has(p)) {
         if (!all.has(p)) all.set(p, []);
         all.get(p)!.push(s);
      } else roots.push(s);
   }
   if (!q) return { roots, children: all };
   const children: Children = new Map();
   const shown = roots.filter((r) => {
      const kids = all.get(r.id) ?? [];
      const own = matches(r, q);
      const hits = own ? kids : kids.filter((k) => matches(k, q));
      if (hits.length) children.set(r.id, hits);
      return own || hits.length > 0;
   });
   return { roots: shown, children };
}

const RANK: Record<SessionStatus, number> = { idle: 0, working: 1, needs_attention: 2 };

/** The status of a parent with its Sub Sessions: needs attention, else working, else idle. */
export const bubbledStatus = (s: SessionSummary, children?: Children): SessionStatus =>
   (children?.get(s.id) ?? []).reduce<SessionStatus>(
      (a, c) => (RANK[c.status] > RANK[a] ? c.status : a),
      s.status,
   );

/** The sort time; a parent's last activity includes its Sub Sessions'. */
const timeOf = (s: SessionSummary, sort: SortBy, children?: Children) =>
   sort === "recent"
      ? Math.max(s.updated_ms, ...(children?.get(s.id) ?? []).map((c) => c.updated_ms))
      : s.created_ms;

/** Sessions needing attention (also through a Sub Session) first, order kept otherwise. */
const attentionFirst = (l: SessionSummary[], children?: Children) => {
   const att = (s: SessionSummary) => bubbledStatus(s, children) === "needs_attention";
   return [...l.filter(att), ...l.filter((s) => !att(s))];
};

export type Group = {
   id: string;
   label: string;
   folder?: boolean;
   quick?: boolean;
   sessions: SessionSummary[];
};

const DAY = 86_400_000;
const DATE_GROUPS: [id: string, label: string, maxAge: number][] = [
   ["recent", "Recent", 3 * DAY],
   ["week", "This week", 7 * DAY],
   ["month", "This month", 30 * DAY],
   ["older", "Older", Infinity],
];

/**
 * Newest first by the sort field, then grouped. Folder groups follow their newest Session, then
 * the Quick group, always last and also when empty (its + starts a Quick Session). Date groups use
 * the sort field's age and skip empty ones. Within each group, Sessions needing attention come
 * first. `none` gives one group with id "all". `list` holds roots only; `children` (from
 * `nestSubSessions`) lends a parent its Sub Sessions' activity and attention.
 */
export function groupSessions(
   list: SessionSummary[],
   v: Pick<ViewOptions, "sort" | "group">,
   now = Date.now(),
   children?: Children,
): Group[] {
   const sorted = [...list].sort(
      (a, b) => timeOf(b, v.sort, children) - timeOf(a, v.sort, children),
   );
   let groups: Group[];
   if (v.group === "folder") {
      const byName = new Map<string, Group>();
      for (const s of sorted) {
         if (s.quick) continue;
         const name = folderName(s.folder);
         if (!byName.has(name))
            byName.set(name, { id: `folder:${name}`, label: name, folder: true, sessions: [] });
         byName.get(name)!.sessions.push(s);
      }
      groups = [
         ...byName.values(),
         { id: "quick", label: "Quick", quick: true, sessions: sorted.filter((s) => s.quick) },
      ];
   } else if (v.group === "date") {
      groups = DATE_GROUPS.map(([id, label]) => ({ id: `date:${id}`, label, sessions: [] }));
      for (const s of sorted)
         groups[
            DATE_GROUPS.findIndex(([, , max]) => now - timeOf(s, v.sort, children) <= max)
         ]!.sessions.push(s);
      groups = groups.filter((g) => g.sessions.length);
   } else {
      groups = [{ id: "all", label: "", sessions: sorted }];
   }
   return groups.map((g) => ({ ...g, sessions: attentionFirst(g.sessions, children) }));
}

/** "12m", "5h", "2d", "3w", else "Oct 12". */
export function relativeTime(ms: number, now = Date.now()): string {
   const min = (now - ms) / 60_000;
   if (min < 60) return `${Math.max(1, Math.floor(min))}m`;
   const h = min / 60;
   if (h < 24) return `${Math.floor(h)}h`;
   const d = Math.floor(h / 24);
   if (d < 7) return `${d}d`;
   if (d < 30) return `${Math.floor(d / 7)}w`;
   return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Full text of the detail row's ref, e.g. "Worktree · opt-in-update · PR #16". */
export function refTitle(ws: WorkspaceInfo): string {
   const branch = branchOf(ws);
   return [
      ws.worktree_branch ? "Worktree" : "Checked out in folder",
      branch,
      ws.pr != null && `PR #${ws.pr}`,
   ]
      .filter(Boolean)
      .join(" · ");
}
