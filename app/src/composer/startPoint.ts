import type { Branches, BranchInfo } from "@harness/api";

/** What the Session starts from in a repository. */
export type Target =
   | { kind: "local"; name: string }
   | { kind: "remote"; name: string }
   | { kind: "new"; name: string };

/** The branch the dialog picks when a folder's branches arrive: the current one, else the default, else the first. */
export function defaultTarget(b: Branches): Target | null {
   const first =
      b.current ?? b.branches.find((x) => x.name === b.default_branch)?.name ?? b.branches[0]?.name;
   return first ? { kind: "local", name: first } : null;
}

/** The branch list's entry of the target (new branches have none). */
export function targetInfo(target: Target | null, b: Branches | null): BranchInfo | undefined {
   if (target?.kind === "local") return b?.branches.find((x) => x.name === target.name);
   if (target?.kind === "remote") return b?.remote.find((x) => x.name === target.name);
   return undefined;
}

/** Another branch than the folder's, checked out elsewhere, or remote-only: needs a Worktree. */
export const mustWorktree = (target: Target | null, info: BranchInfo | undefined) =>
   target?.kind === "remote" || (target?.kind === "local" && !!info?.worktree);

/** The Worktree switch: `locked` (cannot be turned off), `on`, and the note beside it. */
export function worktreeSwitch(o: {
   mode: "branch" | "pr";
   target: Target | null;
   info: BranchInfo | undefined;
   worktree: boolean;
   prWorktree: boolean;
}) {
   const must = mustWorktree(o.target, o.info);
   const locked = o.mode === "branch" && must;
   const on = o.mode === "pr" ? o.prWorktree : o.worktree || must;
   const note = locked
      ? o.target?.kind === "remote"
         ? "needed for a remote branch"
         : "the branch is checked out elsewhere"
      : on
        ? "keeps this folder untouched"
        : "switches this folder's branch";
   return { locked, on, note };
}

/**
 * The Worktree state after picking `t`. Switching the folder to another branch would need a clean
 * tree; a Worktree avoids that. A new branch keeps the choice as it was.
 */
export function worktreeAfterPick(
   t: Target,
   o: { current: string | null; info: BranchInfo | undefined; worktree: boolean },
): boolean {
   return (
      t.kind === "remote" ||
      (t.kind === "local" && (t.name !== o.current || !!o.info?.worktree)) ||
      (t.kind === "new" && o.worktree)
   );
}

/** The `createSession` arguments the start point decides (none outside a repository). */
export function createArgs(o: {
   isRepo: boolean;
   mode: "branch" | "pr";
   pr: { number: number } | null;
   target: Target | null;
   info: BranchInfo | undefined;
   current: string | null;
   worktree: boolean;
   prWorktree: boolean;
}):
   | { pr: number; worktree: boolean }
   | { newBranch: string; worktree: boolean }
   | {
        branch: string | null;
        worktree: boolean;
     }
   | Record<string, never> {
   if (!o.isRepo) return {};
   // The same state the switch renders, so what is shown is what is sent.
   const mode = o.mode === "pr" && o.pr ? "pr" : "branch";
   const { on: worktree } = worktreeSwitch({ ...o, mode });
   if (o.mode === "pr" && o.pr) return { pr: o.pr.number, worktree };
   const { target } = o;
   if (target?.kind === "new") return { newBranch: target.name, worktree };
   return {
      branch:
         target && (target.kind === "remote" || target.name !== o.current) ? target.name : null,
      worktree,
   };
}

/** Whether Create can be pressed for the start point: in a repository a PR or a named branch is needed. */
export const startPointReady = (o: {
   isRepo: boolean;
   mode: "branch" | "pr";
   pr: { number: number } | null;
   target: Target | null;
}) => !o.isRepo || (o.mode === "pr" ? !!o.pr : !!o.target?.name.trim());
