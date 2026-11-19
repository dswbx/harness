import {
   type AgentInfo,
   type Branches,
   type BranchInfo,
   type SessionSummary,
   storedValue,
   type Task,
   type TaskContextParts,
   type TaskStart,
   type TaskStatus,
   type TranscriptSize,
   upstreamId,
} from "@harness/api";

/** Title of a Quick Session until its first prompt (the core's `QUICK_TITLE`). */
export const QUICK_TITLE = "New Quick Session";

/** The Agent for a new Quick Session: the newest used Session's if still installed, else the first. */
export function quickAgent(sessions: SessionSummary[], agents: AgentInfo[]): AgentInfo | undefined {
   const newest = sessions.reduce<SessionSummary | undefined>(
      (a, s) => (s.unused || (a && a.created_ms >= s.created_ms) ? a : s),
      undefined,
   );
   return agents.find((a) => a.id === newest?.agent_id) ?? agents[0];
}

/** Folders picked in the Composer, newest first (per machine; Sessions add their own). */
export const RECENT_KEY = "harness.recentFolders";
const MAX_RECENT = 20;

export type RecentFolder = { path: string; at: number };

const recentStore = storedValue<RecentFolder[]>({
   key: RECENT_KEY,
   scope: "app",
   parse: (raw) => {
      try {
         const v = JSON.parse(raw ?? "[]");
         return Array.isArray(v)
            ? v.filter((x) => typeof x?.path === "string" && typeof x?.at === "number")
            : [];
      } catch {
         return [];
      }
   },
   sync: false,
});

export const loadRecent = (): RecentFolder[] => recentStore.get();

/** Storage unavailable or full: the list falls back to Sessions. */
export function rememberFolder(path: string, now = Date.now()) {
   recentStore.set(mergeRecent([{ path, at: now }], loadRecent()));
}

/** The last Worktree switch the user set by hand (branch mode): the default for the folder's own branch. */
const worktreeStore = storedValue<boolean>({
   key: "harness.composer.worktree",
   scope: "app",
   parse: (raw) => raw === "true",
   sync: false,
});

export const loadWorktreePref = (): boolean => worktreeStore.get();
export const saveWorktreePref = (on: boolean) => worktreeStore.set(on);

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

/** Folders the Sessions started in (a Worktree Session's source folder, not the Worktree). */
export function sessionFolders(sessions: SessionSummary[]): RecentFolder[] {
   return sessions
      .filter((s) => !s.quick)
      .map((s) => ({ path: s.workspace.source_folder || s.folder, at: s.created_ms }));
}

/** `list` with Worktree folders of known Sessions replaced by their source folders. */
export function sourceFolders(list: RecentFolder[], sessions: SessionSummary[]): RecentFolder[] {
   const source = new Map(
      sessions
         .filter((s) => s.workspace.source_folder && s.workspace.source_folder !== s.folder)
         .map((s) => [s.folder.replace(/\/+$/, ""), s.workspace.source_folder]),
   );
   return list.map((r) => ({ ...r, path: source.get(r.path.replace(/\/+$/, "")) ?? r.path }));
}

/** `/Users/me/x` → `~/x` (display only). */
export const tildify = (p: string) => p.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");

/** The paths (once each) not yet in `requested`: what still needs a request. */
export function pathsToRequest(paths: string[], requested: ReadonlySet<string>): string[] {
   return [...new Set(paths)].filter((p) => !requested.has(p));
}

/** Case-insensitive match of every word in `q` against any of `fields`. */
export function matchesWords(q: string, ...fields: (string | undefined)[]): boolean {
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
      matchesWords(q, x.name) &&
      (!(x.worktree || x.archived) || x.name === b?.current || q.trim() !== "");
   const local = b?.branches ?? [];
   const remote = b?.remote ?? [];
   const pick = (x?: BranchInfo) => (x && matchesWords(q, x.name) ? x : undefined);
   return {
      defaultLocal: pick(local.find(isDefault)),
      defaultRemote: pick(remote.find(isDefault)),
      local: local.filter(shown),
      remote: remote.filter(shown),
   };
}

// ---- Start Session from a task (ADR 0028)

/** What the Start dialog needs of a task (`startTaskOf`). */
export type StartTask = {
   id: string;
   title: string;
   /** The prompt the dialog starts with (`taskPrompt`). */
   prompt: string;
   status: TaskStatus;
   /** Under the title: the parent and the upstream id. */
   detail: string;
   assets: number;
   hasBody: boolean;
   hasParent: boolean;
   /** The Session the task was created in, if it still exists. */
   origin: { sessionId: string; title: string; folder: string | null } | null;
};

/** The task context checkboxes, all set. */
export type TaskParts = Required<TaskContextParts>;

const PROMPT_BODY_LINES = 6;

/** The task's title, its upstream link and the first lines of its body. */
export function taskPrompt(t: Pick<Task, "title" | "upstream" | "body">): string {
   const body = t.body.trim().split("\n").slice(0, PROMPT_BODY_LINES).join("\n").trim();
   return [[t.title, t.upstream?.url].filter(Boolean).join("\n"), body]
      .filter(Boolean)
      .join("\n\n");
}

/** The dialog's view of `task`. The folder is the origin Session's source folder (none for a Quick Session). */
export function startTaskOf(
   task: Task,
   parent: Pick<Task, "title"> | null,
   sessions: SessionSummary[],
): StartTask {
   const o = sessions.find((s) => s.id === task.origin_session_id);
   const up = task.upstream && (upstreamId(task.upstream.url) ?? task.upstream.label);
   return {
      id: task.id,
      title: task.title,
      prompt: taskPrompt(task),
      status: task.status,
      detail: [parent?.title, up].filter(Boolean).join(" · "),
      assets: task.assets.length,
      hasBody: task.body.trim() !== "",
      hasParent: !!task.parent_id,
      origin: o
         ? {
              sessionId: o.id,
              title: o.title,
              folder: o.quick ? null : o.workspace.source_folder || o.folder,
           }
         : null,
   };
}

/** The parts ticked when the dialog opens: what the task has, without the origin Session's note and chat. */
export function defaultTaskParts(t: StartTask): TaskParts {
   return {
      summary: true,
      body_and_assets: t.hasBody || t.assets > 0,
      parent_and_siblings: t.hasParent,
      origin_note: false,
      origin_transcript: false,
   };
}

/** "Set status": In progress for a task not started yet, else no change. */
export const defaultSetStatus = (s: TaskStatus): TaskStatus | null =>
   s === "backlog" || s === "todo" ? "in_progress" : null;

/** "12 turns, ~8k chars", or "last 10 of 40 turns, ~24k chars" when the cap drops some. */
export function transcriptLabel(size: TranscriptSize, chars: number): string {
   const k = chars >= 1000 ? `~${Math.round(chars / 1000)}k chars` : `${chars} chars`;
   const turns =
      size.kept_turns < size.total_turns
         ? `last ${size.kept_turns} of ${size.total_turns} turns`
         : `${size.total_turns} turn${size.total_turns === 1 ? "" : "s"}`;
   return `${turns}, ${k}`;
}

/**
 * The `createSession` arguments of a Session started from `task`, and the first prompt (null: none).
 * Parts the task cannot give (no parent, no origin Session) are left out. The title defaults to the task's.
 */
export function startFromTaskArgs(o: {
   task: StartTask;
   include: TaskParts;
   setStatus: TaskStatus | null;
   title: string;
   prompt: string;
}): { title: string; task: TaskStart; prompt: string | null } {
   const { task, include } = o;
   return {
      title: o.title.trim() || task.title,
      task: {
         id: task.id,
         include: {
            summary: include.summary,
            body_and_assets: include.body_and_assets,
            parent_and_siblings: include.parent_and_siblings && task.hasParent,
            origin_note: include.origin_note && !!task.origin,
            origin_transcript: include.origin_transcript && !!task.origin,
         },
         set_status: o.setStatus !== task.status ? o.setStatus : null,
      },
      prompt: o.prompt.trim() || null,
   };
}
