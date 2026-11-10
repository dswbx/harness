import type { AgentInfo, Branches, BranchInfo, SessionSummary } from "@harness/api";

/** Title of a Quick Session until its first prompt (the core's `QUICK_TITLE`). */
export const QUICK_TITLE = "New Quick Session";

/** The Agent for a new Quick Session: the newest Session's if still installed, else the first. */
export function quickAgent(sessions: SessionSummary[], agents: AgentInfo[]): AgentInfo | undefined {
   const newest = sessions.reduce<SessionSummary | undefined>(
      (a, s) => (!a || s.created_ms > a.created_ms ? s : a),
      undefined,
   );
   return agents.find((a) => a.id === newest?.agent_id) ?? agents[0];
}

/** Folders picked in the Composer, newest first (per machine; Sessions add their own). */
export const RECENT_KEY = "harness.recentFolders";
const MAX_RECENT = 20;

export type RecentFolder = { path: string; at: number };

export function loadRecent(): RecentFolder[] {
   try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      return Array.isArray(v)
         ? v.filter((x) => typeof x?.path === "string" && typeof x?.at === "number")
         : [];
   } catch {
      return [];
   }
}

export function rememberFolder(path: string, now = Date.now()) {
   try {
      localStorage.setItem(
         RECENT_KEY,
         JSON.stringify(mergeRecent([{ path, at: now }], loadRecent())),
      );
   } catch {
      // Storage unavailable: the list falls back to Sessions.
   }
}

/** Newest first, one entry per path (its newest use), at most MAX_RECENT. */
export function mergeRecent(...lists: RecentFolder[][]): RecentFolder[] {
   const best = new Map<string, number>();
   for (const { path, at } of lists.flat()) {
      const p = path.replace(/\/+$/, "") || "/";
      best.set(p, Math.max(at, best.get(p) ?? 0));
   }
   return [...best]
      .map(([path, at]) => ({ path, at }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_RECENT);
}

/** Folders of Sessions that work in the folder itself (a Worktree Session's folder is the Worktree). */
export function sessionFolders(sessions: SessionSummary[]): RecentFolder[] {
   return sessions
      .filter((s) => !s.workspace.worktree_branch && !s.quick)
      .map((s) => ({ path: s.folder, at: s.created_ms }));
}

/** `/Users/me/x` → `~/x` (display only). */
export const tildify = (p: string) => p.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");

/** Short age: "now", "5m", "3h", "Yesterday", "4d", "2w", "Mar 3". */
export function relTime(ms: number, now = Date.now()): string {
   const s = Math.max(0, (now - ms) / 1000);
   if (s < 60) return "now";
   if (s < 3600) return `${Math.floor(s / 60)}m`;
   if (s < 86400) return `${Math.floor(s / 3600)}h`;
   const d = Math.floor(s / 86400);
   if (d === 1) return "Yesterday";
   if (d < 14) return `${d}d`;
   if (d < 60) return `${Math.floor(d / 7)}w`;
   return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Case-insensitive match of every word in `q` against any of `fields`. */
export function matches(q: string, ...fields: (string | undefined)[]): boolean {
   const hay = fields.join(" ").toLowerCase();
   return q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => hay.includes(w));
}

/** The branch picker's rows for search `q`: the default branch apart (to pin it on top), then the rest. Branches checked out in another worktree or left by an archived Session only show when searching (the current one always does). */
export function branchChoices(b: Branches | null, q: string) {
   const isDefault = (x: BranchInfo) => x.name === b?.default_branch;
   const shown = (x: BranchInfo) =>
      !isDefault(x) &&
      matches(q, x.name) &&
      (!(x.worktree || x.archived) || x.name === b?.current || q.trim() !== "");
   const local = b?.branches ?? [];
   const remote = b?.remote ?? [];
   const pick = (x?: BranchInfo) => (x && matches(q, x.name) ? x : undefined);
   return {
      defaultLocal: pick(local.find(isDefault)),
      defaultRemote: pick(remote.find(isDefault)),
      local: local.filter(shown),
      remote: remote.filter(shown),
   };
}
