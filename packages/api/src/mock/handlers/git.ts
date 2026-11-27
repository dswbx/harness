import { CommandError } from "../../errors";
import type { CommandResult } from "../../generated";
import { MOCK_BRANCHES, MOCK_REMOTE } from "../fixtures/branches";
import { MOCK_COMMIT_FILES, MOCK_COMMITS, MOCK_FILES, MOCK_UNCOMMITTED } from "../fixtures/git";
import { MOCK_NEW, MOCK_OLD, MOCK_PATCH } from "../mockRepo";
import type { Handlers } from "./types";

export const gitHandlers = {
   ListBranches: (_mock, cmd) => {
      return {
         type: "Branches",
         branches: cmd.folder.includes("norepo")
            ? {
                 repo_root: null,
                 current: null,
                 default_branch: null,
                 branches: [],
                 remote: [],
              }
            : {
                 repo_root: cmd.folder,
                 current: "main",
                 default_branch: "main",
                 branches: MOCK_BRANCHES,
                 remote: MOCK_REMOTE,
              },
      };
   },
   GitStatus: (mock, cmd) => {
      if (!mock.session(cmd.session_id).workspace.repo_root)
         throw new CommandError("invalid", "not a git repository");
      return {
         type: "GitStatus",
         status: {
            branch: mock.session(cmd.session_id).workspace.worktree_branch ?? "main",
            upstream: null,
            ahead: mock.ahead.get(cmd.session_id) ?? 0,
            behind:
               MOCK_BRANCHES.find(
                  (b) =>
                     b.name === (mock.session(cmd.session_id).workspace.worktree_branch ?? "main"),
               )?.behind ?? 0,
            files: mock.committed.has(cmd.session_id) ? [] : MOCK_FILES,
         },
      };
   },
   GitDiff: (mock, cmd) => {
      if (!mock.session(cmd.session_id).workspace.repo_root)
         throw new CommandError("invalid", "not a git repository");
      return mockDiff(cmd.from, cmd.to, mock.committed.has(cmd.session_id));
   },
   FolderGitDiff: (_mock, cmd) => {
      folderRepo(cmd.folder);
      return mockDiff(cmd.from, cmd.to, false);
   },
   FolderGitLog: (_mock, cmd) => {
      folderRepo(cmd.folder);
      return { type: "GitLog", commits: [...MOCK_COMMITS] };
   },
   FolderGitShowFile: (_mock, cmd) => {
      folderRepo(cmd.folder);
      return mockShowFile(cmd.rev, cmd.path);
   },
   GitLog: (mock, cmd) => {
      if (!mock.session(cmd.session_id).workspace.repo_root)
         throw new CommandError("invalid", "not a git repository");
      return { type: "GitLog", commits: [...MOCK_COMMITS] };
   },
   GitShowFile: (_mock, cmd) => mockShowFile(cmd.rev, cmd.path),
   GitCommit: (mock, cmd) => {
      if (!cmd.message.trim()) throw new CommandError("invalid", "empty commit message");
      const commit = `c${++mock.commitN}ab12cd`;
      mock.committed.add(cmd.session_id);
      mock.ahead.set(cmd.session_id, (mock.ahead.get(cmd.session_id) ?? 0) + 1);
      mock.emit(cmd.session_id, {
         type: "GitCommitted",
         commit,
         message: cmd.message,
         by: "user",
      });
      return { type: "Committed", commit };
   },
   UpdateBranch: async (_mock, cmd) => {
      if (cmd.folder.includes("norepo")) throw new CommandError("invalid", "not a git repository");
      await new Promise((r) => setTimeout(r, 600));
      const b = MOCK_BRANCHES.find((b) => b.name === cmd.branch);
      if (!b) throw new CommandError("internal", `fatal: couldn't find remote ref ${cmd.branch}`);
      b.behind = 0;
      return { type: "Ok" };
   },
   GitPush: (mock, cmd) => {
      mock.ahead.set(cmd.session_id, 0);
      mock.emit(cmd.session_id, {
         type: "GitPushed",
         branch: mock.session(cmd.session_id).workspace.worktree_branch ?? "main",
         by: "user",
      });
      return { type: "Ok" };
   },
} satisfies Partial<Handlers>;

/** The mock's rule for a Folder Diff path: absolute, and any folder named `norepo` is not in git. */
function folderRepo(folder: string) {
   if (!folder.startsWith("/"))
      throw new CommandError("invalid", `${folder} is not an absolute path`);
   if (folder.includes("norepo"))
      throw new CommandError("invalid", `${folder} is not in a git repository`);
}

/** The mock diff for `from`..`to`; `done` (everything committed) empties the default range. */
function mockDiff(from: string | null, to: string | null, done: boolean): CommandResult {
   if (from !== null || to !== null) {
      // Revs the UI sends: "HEAD".."" = uncommitted; "<sha>^"..("<sha>" | null) = commits in the span.
      let paths: Set<string>;
      if (from === "HEAD") paths = new Set(MOCK_UNCOMMITTED);
      else {
         const start = MOCK_COMMITS.findIndex((c) => from === `${c.sha}^`);
         const end = to === null ? 0 : MOCK_COMMITS.findIndex((c) => c.sha === to);
         paths = new Set<string>();
         if (start >= 0 && end >= 0)
            for (const c of MOCK_COMMITS.slice(end, start + 1))
               for (const f of MOCK_COMMIT_FILES[c.sha]) paths.add(f);
         if (to === null) for (const f of MOCK_UNCOMMITTED) paths.add(f);
      }
      const files = MOCK_FILES.filter((f) => paths.has(f.path));
      const patch = MOCK_PATCH.split(/(?=^diff --git )/m)
         .filter((c) => files.some((f) => c.startsWith(`diff --git a/${f.path} `)))
         .join("");
      return { type: "Diff", diff: { from: from ?? "base", to: to ?? "worktree", files, patch } };
   }
   return {
      type: "Diff",
      diff: {
         from: "base",
         to: "worktree",
         files: done ? [] : MOCK_FILES,
         patch: done ? "" : MOCK_PATCH,
      },
   };
}

/** Old side: "base" and any "<sha>^"; everything else falls back to the new contents. */
function mockShowFile(rev: string, path: string): CommandResult {
   return {
      type: "FileContent",
      content: (rev === "base" || rev.endsWith("^") ? MOCK_OLD : MOCK_NEW)[path] ?? "",
   };
}
