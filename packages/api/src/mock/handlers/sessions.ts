import { CommandError } from "../../errors";
import type { WorkspaceInfo } from "../../generated";
import { MOCK_PRS } from "../fixtures/branches";
import type { MockTransport } from "../mock";
import { MOCK_NEW } from "../mockRepo";
import { forgetSessionTasks, linkSessionTask, mockTask } from "./tasks";
import type { Handlers } from "./types";

/** Like `Session::archive`/`unarchive`: logs the change, and refuses a no-op with `conflict`. */
const setOne = (mock: MockTransport, id: string, archived: boolean) => {
   const s = mock.session(id);
   if (s.archived === archived)
      throw new CommandError("conflict", archived ? "already archived" : "not archived");
   s.archived = archived;
   mock.emitApp({ type: "SessionsChanged" });
   mock.emit(id, { type: "SessionArchived", archived });
};

/** Files outside the mock Session folder, by `~/` path. Under `~/.aws/` they can hold secrets (locked until allowed). */
const MOCK_HOME: Record<string, string> = {
   "~/notes/ideas.md": "# Ideas\n\n- A dark theme for the docs site.\n- Shorter release notes.\n",
   "~/.aws/config": "[default]\nregion = made-up-1\noutput = json\n",
};
const lockedReason = (path: string) =>
   path.startsWith("~/.aws/") ? "in the hidden folder ~/.aws" : null;
/** Files each mock Session may read although they can hold secrets (`ApproveSessionFile`). */
const allowedFiles = new Map<string, Set<string>>();

/** Sub Sessions of `id`, oldest first. */
const children = (mock: MockTransport, id: string) =>
   mock.sessions
      .filter((s) => s.parent?.session_id === id)
      .sort((a, b) => a.created_ms - b.created_ms);

export const sessionsHandlers = {
   ListSessions: (mock) => {
      // Copies, as over IPC: the mock edits its own in place.
      return { type: "Sessions", sessions: mock.sessions.map((s) => structuredClone(s)) };
   },
   CreateSession: (mock, cmd) => {
      if (cmd.task) mockTask(mock, cmd.task.id);
      const id = `mock-${++mock.n + 1}`;
      const isRepo = !cmd.folder.includes("norepo");
      if (!isRepo && (cmd.worktree || cmd.branch))
         throw new CommandError(
            "invalid",
            "not a git repository: worktree and branch are not available",
         );
      const pr = cmd.pr != null ? MOCK_PRS.find((p) => p.number === cmd.pr) : undefined;
      if (cmd.pr != null && !pr) throw new CommandError("not_found", `no pull request #${cmd.pr}`);
      if (!pr && !cmd.worktree && !cmd.new_branch && cmd.branch && cmd.branch !== "main")
         throw new CommandError(
            "conflict",
            "cannot check out branch: the folder has uncommitted changes",
         );
      const worktree = cmd.worktree;
      const prefix = mock.resolvedBranchPrefix();
      const newBranch = prefix ? `${prefix}/${id.slice(-6)}` : id;
      const workspace: WorkspaceInfo = {
         repo_root: isRepo ? cmd.folder : null,
         source_folder: cmd.folder,
         worktree_branch: worktree ? (pr ? pr.head : (cmd.new_branch ?? newBranch)) : null,
         base_branch: worktree ? (pr ? pr.base : (cmd.branch ?? "main")) : null,
         branch: !isRepo
            ? null
            : worktree
              ? pr
                 ? pr.head
                 : (cmd.new_branch ?? newBranch)
              : pr
                ? pr.head
                : (cmd.new_branch ?? cmd.branch ?? "main"),
         pr: pr?.number ?? null,
         pr_state: pr ? "open" : null,
         pr_checks: null,
      };
      const title =
         cmd.title ?? (pr ? `#${pr.number} ${pr.title}` : (cmd.folder.split("/").pop() ?? id));
      mock.addSession(id, title, cmd.frontend_id, false, cmd.folder, workspace);
      if (cmd.task) {
         linkSessionTask(mock, cmd.task.id, id, title, cmd.task.set_status ?? null);
      }
      mock.emitApp({ type: "SessionsChanged" });
      return { type: "SessionCreated", session_id: id };
   },
   CreateQuickSession: (mock, cmd) => {
      const id = `mock-${++mock.n + 1}`;
      mock.addQuickSession(id, cmd.title ?? "New Quick Session", cmd.frontend_id, cmd.agent_id);
      mock.session(id).unused = true;
      mock.emitApp({ type: "SessionsChanged" });
      return { type: "SessionCreated", session_id: id };
   },
   DiscardEmptySession: (mock, cmd) => {
      // Unknown Session: nothing to do, like the core.
      if (mock.sessions.find((x) => x.id === cmd.session_id)?.unused) {
         mock.sessions = mock.sessions.filter((x) => x.id !== cmd.session_id);
         mock.emitApp({ type: "SessionsChanged" });
      }
      return { type: "Ok" };
   },
   MarkSessionSeen: (mock, cmd) => {
      const s = mock.session(cmd.session_id);
      if (s.unseen) {
         s.unseen = false;
         mock.emitApp({
            type: "SessionStatus",
            session_id: s.id,
            title: s.title,
            status: s.status,
            unused: s.unused,
            unseen: false,
            title_explicit: s.title_explicit,
         });
      }
      return { type: "Ok" };
   },
   // Like the core: logged on the Session and announced; Agent titles no longer replace it.
   SetSessionTitle: (mock, cmd) => {
      const s = mock.session(cmd.session_id);
      const title = cmd.title.trim().split(/\s+/).join(" ").slice(0, 80);
      if (!title) throw new CommandError("invalid", "title is empty");
      if (!s.title_explicit) mock.autoTitles.set(s.id, s.title);
      s.title = title;
      s.title_explicit = true;
      mock.emit(s.id, { type: "SessionInfoUpdated", title }, null);
      mock.emitApp({
         type: "SessionStatus",
         session_id: s.id,
         title,
         status: s.status,
         unused: s.unused,
         unseen: s.unseen,
         title_explicit: true,
      });
      return { type: "Ok" };
   },
   // Like the core: back to the automatic title, Agent titles replace it again.
   ResetSessionTitle: (mock, cmd) => {
      const s = mock.session(cmd.session_id);
      const title = mock.autoTitles.get(s.id) ?? s.title;
      mock.autoTitles.delete(s.id);
      s.title = title;
      s.title_explicit = false;
      mock.emit(s.id, { type: "SessionInfoUpdated", title }, null);
      mock.emitApp({
         type: "SessionStatus",
         session_id: s.id,
         title,
         status: s.status,
         unused: s.unused,
         unseen: s.unseen,
         title_explicit: false,
      });
      return { type: "Ok" };
   },
   // Like the core: archiving a Session first archives its Sub Sessions, unarchiving restores them.
   ArchiveSession: (mock, cmd) => {
      mock.session(cmd.session_id);
      for (const c of children(mock, cmd.session_id).filter((c) => !c.archived))
         setOne(mock, c.id, true);
      setOne(mock, cmd.session_id, true);
      return { type: "Ok" };
   },
   UnarchiveSession: (mock, cmd) => {
      setOne(mock, cmd.session_id, false);
      for (const c of children(mock, cmd.session_id).filter((c) => c.archived))
         setOne(mock, c.id, false);
      return { type: "Ok" };
   },
   DeleteSession: (mock, cmd) => {
      const s = mock.session(cmd.session_id);
      if (s.workspace.worktree_branch && !cmd.force)
         throw new CommandError(
            "conflict",
            `Worktree branch ${s.workspace.worktree_branch} has unmerged commits; delete anyway to discard them`,
         );
      mock.sessions = mock.sessions.filter((x) => x.id !== cmd.session_id);
      let detached = false;
      for (const a of mock.shared.values()) {
         if (!a.meta.attached?.includes(cmd.session_id)) continue;
         a.meta.attached = a.meta.attached.filter((x) => x !== cmd.session_id);
         detached = true;
      }
      mock.emitApp({ type: "SessionsChanged" });
      if (detached) mock.emitApp({ type: "SharedArtifactsChanged" });
      mock.notes.delete(cmd.session_id);
      forgetSessionTasks(mock, cmd.session_id);
      return { type: "Ok" };
   },
   ListSessionFiles: () => {
      return { type: "SessionFiles", files: Object.keys(MOCK_NEW).sort(), prefix: "" };
   },
   ReadSessionFile: (_mock, cmd) => {
      const want = cmd.path.replace(/^\.\//, "");
      const outside = want in MOCK_HOME;
      const hits = outside
         ? [want]
         : want in MOCK_NEW
           ? [want]
           : Object.keys(MOCK_NEW).filter((p) => p.endsWith(`/${want}`));
      if (hits.length !== 1)
         throw new CommandError("internal", `${cmd.path}: No such file or directory`);
      const path = hits[0]!;
      const reason = lockedReason(path);
      const allowed = !!reason && !!allowedFiles.get(cmd.session_id)?.has(path);
      if (reason && !allowed) throw new CommandError("needs_approval", reason);
      const text = outside ? MOCK_HOME[path]! : MOCK_NEW[path]!;
      const all = text.replace(/\n$/, "").split("\n");
      const start = Math.max(1, cmd.start ?? 1);
      const end = Math.min(all.length, cmd.end ?? all.length);
      return {
         type: "FileLines",
         path,
         start,
         lines: all.slice(start - 1, Math.max(start - 1, end)),
         total: all.length,
         scope: allowed ? "allowed" : outside ? "outside" : "inside",
      };
   },
   ApproveSessionFile: (_mock, cmd) => {
      if (!(cmd.path in MOCK_HOME))
         throw new CommandError("internal", `${cmd.path}: No such file or directory`);
      const set = allowedFiles.get(cmd.session_id) ?? new Set();
      set.add(cmd.path);
      allowedFiles.set(cmd.session_id, set);
      return { type: "Ok" };
   },
   RevokeSessionFile: (_mock, cmd) => {
      allowedFiles.get(cmd.session_id)?.delete(cmd.path);
      return { type: "Ok" };
   },
} satisfies Partial<Handlers>;
