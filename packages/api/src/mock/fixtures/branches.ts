import type { BranchInfo, PullRequest } from "../../generated";

export const ago = (h: number) => Math.floor(Date.now() / 1000) - h * 3600;
export const MOCK_BRANCHES: BranchInfo[] = [
   { name: "main", time: ago(0.1), ahead: 0, behind: 21, worktree: false, archived: false },
   { name: "feature/login", time: ago(4), ahead: 3, behind: 1, worktree: false, archived: false },
   {
      name: "feature/compact-header",
      time: ago(50),
      ahead: 0,
      behind: 0,
      worktree: true,
      archived: false,
   },
   {
      name: "harness/old-parser-fix",
      time: ago(300),
      ahead: 0,
      behind: 0,
      worktree: false,
      archived: true,
   },
];
export const MOCK_REMOTE: BranchInfo[] = [
   {
      name: "origin/feature/completions",
      time: ago(170),
      ahead: 0,
      behind: 0,
      worktree: false,
      archived: false,
   },
];
export const MOCK_PRS: PullRequest[] = [
   {
      number: 142,
      title: "Prompt attachments: images and files",
      author: "you",
      head: "feat/attachments",
      base: "main",
      draft: false,
      fork: false,
      checks: "passing",
      updated_at: new Date(Date.now() - 2 * 3600e3).toISOString(),
   },
   {
      number: 139,
      title: "Side threads keep their own config",
      author: "you",
      head: "side-thread-config",
      base: "main",
      draft: true,
      fork: false,
      checks: "pending",
      updated_at: new Date(Date.now() - 26 * 3600e3).toISOString(),
   },
   {
      number: 137,
      title: "Fix diff panel scroll on large files",
      author: "contributor",
      head: "fix/diff-scroll",
      base: "main",
      draft: false,
      fork: true,
      checks: "failing",
      updated_at: new Date(Date.now() - 72 * 3600e3).toISOString(),
   },
];
