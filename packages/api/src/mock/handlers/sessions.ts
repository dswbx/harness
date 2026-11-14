import { CommandError } from "../../errors";
import type { Command, CommandResult, WorkspaceInfo } from "../../generated";
import { MOCK_PRS } from "../fixtures/branches";
import type { MockTransport } from "../mock";
import { MOCK_NEW } from "../mockRepo";
import type { Handlers } from "./types";

const setArchived = (
   mock: MockTransport,
   cmd: Extract<Command, { type: "ArchiveSession" | "UnarchiveSession" }>,
): CommandResult => {
   const archived = cmd.type === "ArchiveSession";
   mock.session(cmd.session_id).archived = archived;
   mock.emit(cmd.session_id, { type: "SessionArchived", archived });
   mock.emitApp({ type: "SessionsChanged" });
   return { type: "Ok" };
};

export const sessionsHandlers = {
   ListSessions: (mock) => {
      return { type: "Sessions", sessions: [...mock.sessions] };
   },
   CreateSession: (mock, cmd) => {
      const id = `mock-${++mock.n + 1}`;
      const isRepo = !cmd.folder.includes("norepo");
      if (!isRepo && (cmd.worktree || cmd.branch))
         throw new CommandError(
            "internal",
            "not a git repository: worktree and branch are not available",
         );
      const pr = cmd.pr != null ? MOCK_PRS.find((p) => p.number === cmd.pr) : undefined;
      if (cmd.pr != null && !pr) throw new CommandError("internal", `no pull request #${cmd.pr}`);
      if (!pr && !cmd.worktree && !cmd.new_branch && cmd.branch && cmd.branch !== "main")
         throw new CommandError(
            "internal",
            "cannot check out branch: the folder has uncommitted changes",
         );
      const worktree = cmd.worktree;
      const workspace: WorkspaceInfo = {
         repo_root: isRepo ? cmd.folder : null,
         source_folder: cmd.folder,
         worktree_branch: worktree ? (pr ? pr.head : (cmd.new_branch ?? `harness/${id}`)) : null,
         base_branch: worktree ? (pr ? pr.base : (cmd.branch ?? "main")) : null,
         branch: !isRepo
            ? null
            : worktree
              ? pr
                 ? pr.head
                 : (cmd.new_branch ?? `harness/${id}`)
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
      mock.emitApp({ type: "SessionsChanged" });
      return { type: "SessionCreated", session_id: id };
   },
   CreateQuickSession: (mock, cmd) => {
      const id = `mock-${++mock.n + 1}`;
      mock.addQuickSession(id, cmd.title ?? "New Quick Session", cmd.frontend_id);
      mock.unusedQuick.add(id);
      mock.emitApp({ type: "SessionsChanged" });
      return { type: "SessionCreated", session_id: id };
   },
   DiscardEmptySession: (mock, cmd) => {
      if (mock.unusedQuick.delete(cmd.session_id)) {
         mock.sessions = mock.sessions.filter((x) => x.id !== cmd.session_id);
         mock.emitApp({ type: "SessionsChanged" });
      }
      return { type: "Ok" };
   },
   ArchiveSession: setArchived,
   UnarchiveSession: setArchived,
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
      return { type: "Ok" };
   },
   ListSessionFiles: () => {
      return { type: "SessionFiles", files: Object.keys(MOCK_NEW).sort(), prefix: "" };
   },
   ReadSessionFile: (_mock, cmd) => {
      const want = cmd.path.replace(/^\.\//, "");
      const hits =
         want in MOCK_NEW ? [want] : Object.keys(MOCK_NEW).filter((p) => p.endsWith(`/${want}`));
      if (hits.length !== 1)
         throw new CommandError("internal", `${cmd.path}: No such file or directory`);
      const path = hits[0]!;
      const text = MOCK_NEW[path]!;
      const all = text.replace(/\n$/, "").split("\n");
      const start = Math.max(1, cmd.start ?? 1);
      const end = Math.min(all.length, cmd.end ?? all.length);
      return {
         type: "FileLines",
         path,
         start,
         lines: all.slice(start - 1, Math.max(start - 1, end)),
         total: all.length,
      };
   },
} satisfies Partial<Handlers>;
