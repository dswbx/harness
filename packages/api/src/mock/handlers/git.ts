import { CommandError } from "../../errors";
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
         throw new CommandError("internal", "not a git repository");
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
         throw new CommandError("internal", "not a git repository");
      if (cmd.from !== null || cmd.to !== null) {
         // Revs the UI sends: "HEAD".."" = uncommitted; "<sha>^"..("<sha>" | null) = commits in the span.
         let paths: Set<string>;
         if (cmd.from === "HEAD") paths = new Set(MOCK_UNCOMMITTED);
         else {
            const start = MOCK_COMMITS.findIndex((c) => cmd.from === `${c.sha}^`);
            const end = cmd.to === null ? 0 : MOCK_COMMITS.findIndex((c) => c.sha === cmd.to);
            paths = new Set<string>();
            if (start >= 0 && end >= 0)
               for (const c of MOCK_COMMITS.slice(end, start + 1))
                  for (const f of MOCK_COMMIT_FILES[c.sha]) paths.add(f);
            if (cmd.to === null) for (const f of MOCK_UNCOMMITTED) paths.add(f);
         }
         const files = MOCK_FILES.filter((f) => paths.has(f.path));
         const patch = MOCK_PATCH.split(/(?=^diff --git )/m)
            .filter((c) => files.some((f) => c.startsWith(`diff --git a/${f.path} `)))
            .join("");
         return {
            type: "Diff",
            diff: { from: cmd.from ?? "base", to: cmd.to ?? "worktree", files, patch },
         };
      }
      const done = mock.committed.has(cmd.session_id) && cmd.from === null && cmd.to === null;
      return {
         type: "Diff",
         diff: {
            from: cmd.from ?? "base",
            to: cmd.to ?? "worktree",
            files: done ? [] : MOCK_FILES,
            patch: done ? "" : MOCK_PATCH,
         },
      };
   },
   GitLog: (mock, cmd) => {
      if (!mock.session(cmd.session_id).workspace.repo_root)
         throw new CommandError("internal", "not a git repository");
      return { type: "GitLog", commits: [...MOCK_COMMITS] };
   },
   GitShowFile: (_mock, cmd) => {
      // Old side: "base" and any "<sha>^"; everything else falls back to the new contents.
      return {
         type: "FileContent",
         content:
            (cmd.rev === "base" || cmd.rev.endsWith("^") ? MOCK_OLD : MOCK_NEW)[cmd.path] ?? "",
      };
   },
   GitCommit: (mock, cmd) => {
      if (!cmd.message.trim()) throw new CommandError("internal", "empty commit message");
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
      if (cmd.folder.includes("norepo")) throw new CommandError("internal", "not a git repository");
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
