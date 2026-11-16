import type { Branches, BranchInfo } from "@harness/api";
import { describe, expect, it } from "vitest";
import {
   createArgs,
   defaultTarget,
   mustWorktree,
   startPointReady,
   type Target,
   targetInfo,
   worktreeAfterPick,
   worktreeSwitch,
} from "./startPoint";

const br = (name: string, over: Partial<BranchInfo> = {}): BranchInfo => ({
   name,
   time: 0,
   ahead: 0,
   behind: 0,
   worktree: false,
   archived: false,
   ...over,
});
const branches = (over: Partial<Branches> = {}): Branches => ({
   repo_root: "/r",
   current: "feature",
   default_branch: "main",
   branches: [br("feature"), br("main"), br("busy", { worktree: true })],
   remote: [br("origin/other")],
   ...over,
});
const b = branches();
const local = (name: string): Target => ({ kind: "local", name });
const remote = (name: string): Target => ({ kind: "remote", name });
const fresh = (name: string): Target => ({ kind: "new", name });
const info = (t: Target | null) => targetInfo(t, b);
const sw = (mode: "branch" | "pr", target: Target | null, worktree = false, prWorktree = true) =>
   worktreeSwitch({ mode, target, info: info(target), worktree, prWorktree });

describe("defaultTarget", () => {
   it("is the current branch", () => {
      expect(defaultTarget(b)).toEqual(local("feature"));
   });
   it("else the default branch, else the first one", () => {
      expect(defaultTarget(branches({ current: null }))).toEqual(local("main"));
      expect(defaultTarget(branches({ current: null, default_branch: null }))).toEqual(
         local("feature"),
      );
      expect(defaultTarget(branches({ current: null, default_branch: "gone" }))).toEqual(
         local("feature"),
      );
   });
   it("is null without branches", () => {
      expect(defaultTarget(branches({ current: null, default_branch: null, branches: [] }))).toBe(
         null,
      );
   });
});

describe("targetInfo and mustWorktree", () => {
   it("finds local and remote entries; a new branch or nothing has none", () => {
      expect(info(local("busy"))?.worktree).toBe(true);
      expect(info(remote("origin/other"))?.name).toBe("origin/other");
      expect(info(remote("origin/missing"))).toBeUndefined();
      expect(info(fresh("x"))).toBeUndefined();
      expect(info(null)).toBeUndefined();
      expect(targetInfo(local("main"), null)).toBeUndefined();
   });
   it("a Worktree is needed for a remote branch or one checked out elsewhere", () => {
      expect(mustWorktree(remote("origin/other"), info(remote("origin/other")))).toBe(true);
      expect(mustWorktree(local("busy"), info(local("busy")))).toBe(true);
      expect(mustWorktree(local("main"), info(local("main")))).toBe(false);
      expect(mustWorktree(local("feature"), info(local("feature")))).toBe(false);
      expect(mustWorktree(fresh("x"), undefined)).toBe(false);
      expect(mustWorktree(null, undefined)).toBe(false);
   });
});

describe("worktreeSwitch", () => {
   it("local branch of the folder: free, off by default", () => {
      expect(sw("branch", local("feature"))).toEqual({
         locked: false,
         on: false,
         note: "switches this folder's branch",
      });
      expect(sw("branch", local("feature"), true)).toMatchObject({ locked: false, on: true });
      expect(sw("branch", local("feature"), true).note).toBe("keeps this folder untouched");
   });
   it("remote branch: locked on", () => {
      expect(sw("branch", remote("origin/other"))).toEqual({
         locked: true,
         on: true,
         note: "needed for a remote branch",
      });
   });
   it("checked out elsewhere: locked on, even when the state says off", () => {
      expect(sw("branch", local("busy"), false)).toEqual({
         locked: true,
         on: true,
         note: "the branch is checked out elsewhere",
      });
   });
   it("new branch: follows the choice", () => {
      expect(sw("branch", fresh("x"), false).on).toBe(false);
      expect(sw("branch", fresh("x"), true).on).toBe(true);
   });
   it("PR: never locked, follows its own choice (on by default)", () => {
      expect(sw("pr", local("busy"), false, true)).toMatchObject({ locked: false, on: true });
      expect(sw("pr", remote("origin/other"), true, false)).toMatchObject({
         locked: false,
         on: false,
      });
   });
});

describe("worktreeAfterPick", () => {
   const after = (t: Target, worktree = false) =>
      worktreeAfterPick(t, { current: b.current, info: info(t), worktree });
   it("the folder's own branch: no Worktree", () => {
      expect(after(local("feature"))).toBe(false);
   });
   it("the folder's own branch: the remembered choice", () => {
      expect(
         worktreeAfterPick(local("feature"), {
            current: b.current,
            info: info(local("feature")),
            worktree: false,
            preferred: true,
         }),
      ).toBe(true);
   });
   it("another local branch: a Worktree (switching needs a clean tree)", () => {
      expect(after(local("main"))).toBe(true);
   });
   it("a branch checked out elsewhere, remote: a Worktree", () => {
      expect(after(local("busy"))).toBe(true);
      expect(after(remote("origin/other"))).toBe(true);
   });
   it("a new branch keeps the choice", () => {
      expect(after(fresh("x"), false)).toBe(false);
      expect(after(fresh("x"), true)).toBe(true);
   });
   it("with a detached HEAD every local branch is another branch", () => {
      expect(
         worktreeAfterPick(local("main"), {
            current: null,
            info: info(local("main")),
            worktree: false,
         }),
      ).toBe(true);
   });
});

describe("createArgs", () => {
   const args = (over: Partial<Parameters<typeof createArgs>[0]> = {}) => {
      const target = over.target === undefined ? local("feature") : over.target;
      return createArgs({
         isRepo: true,
         mode: "branch",
         pr: null,
         target,
         info: info(target),
         current: "feature",
         worktree: false,
         prWorktree: true,
         ...over,
      });
   };

   it("what is sent is what the switch shows, for every target and mode", () => {
      for (const mode of ["branch", "pr"] as const) {
         for (const target of [null, local("feature"), local("main"), local("busy")].concat([
            remote("origin/other"),
            fresh("topic"),
         ])) {
            for (const worktree of [false, true]) {
               for (const prWorktree of [false, true]) {
                  const sent = args({ mode, pr: { number: 1 }, target, worktree, prWorktree });
                  expect((sent as { worktree: boolean }).worktree).toBe(
                     worktreeSwitch({ mode, target, info: info(target), worktree, prWorktree }).on,
                  );
               }
            }
         }
      }
   });

   it("outside a repository: nothing", () => {
      expect(args({ isRepo: false })).toEqual({});
      expect(args({ isRepo: false, mode: "pr", pr: { number: 3 } })).toEqual({});
   });
   it("the folder's own branch: no branch, no Worktree", () => {
      expect(args()).toEqual({ branch: null, worktree: false });
   });
   it("another local branch: its name, with the Worktree the dialog set", () => {
      expect(args({ target: local("main"), worktree: true })).toEqual({
         branch: "main",
         worktree: true,
      });
   });
   it("a local branch checked out elsewhere (picked, so the Worktree state is on)", () => {
      expect(args({ target: local("busy"), worktree: true })).toEqual({
         branch: "busy",
         worktree: true,
      });
   });
   it("a remote branch: always in a Worktree", () => {
      expect(args({ target: remote("origin/other"), worktree: false })).toEqual({
         branch: "origin/other",
         worktree: true,
      });
   });
   it("a new branch: its name, no base branch, the Worktree choice", () => {
      expect(args({ target: fresh("topic"), worktree: false })).toEqual({
         newBranch: "topic",
         worktree: false,
      });
      expect(args({ target: fresh("topic"), worktree: true })).toEqual({
         newBranch: "topic",
         worktree: true,
      });
   });
   it("a PR: its number and the PR Worktree choice, whatever the branch target", () => {
      expect(args({ mode: "pr", pr: { number: 42 }, target: local("busy") })).toEqual({
         pr: 42,
         worktree: true,
      });
      expect(args({ mode: "pr", pr: { number: 42 }, prWorktree: false })).toEqual({
         pr: 42,
         worktree: false,
      });
   });
   it("PR mode without a pick falls back to the branch target", () => {
      expect(args({ mode: "pr", pr: null })).toEqual({ branch: null, worktree: false });
   });
   it("no target at all: the folder as it is", () => {
      expect(args({ target: null })).toEqual({ branch: null, worktree: false });
   });
   it("detached HEAD: any local branch is named", () => {
      expect(args({ current: null, target: local("main"), worktree: true })).toEqual({
         branch: "main",
         worktree: true,
      });
   });

   // Intended: the Worktree switch shows ON and locked for a branch checked out elsewhere, so it must be sent
   // as a Worktree. The dialog's initial pick (`defaultTarget`, worktree state false) is the default branch
   // when HEAD is detached; if that one is checked out elsewhere, the switch shows on but `worktree: false` is sent.
   it("an initial pick locked on by mustWorktree sends worktree: true", () => {
      const detached = branches({
         current: null,
         branches: [br("main", { worktree: true }), br("feature")],
      });
      const target = defaultTarget(detached)!;
      const locked = worktreeSwitch({
         mode: "branch",
         target,
         info: targetInfo(target, detached),
         worktree: false,
         prWorktree: true,
      });
      expect(locked.on).toBe(true);
      expect(
         createArgs({
            isRepo: true,
            mode: "branch",
            pr: null,
            target,
            info: targetInfo(target, detached),
            current: null,
            worktree: false,
            prWorktree: true,
         }),
      ).toMatchObject({ worktree: true });
   });
});

describe("startPointReady", () => {
   const ready = (o: Partial<Parameters<typeof startPointReady>[0]>) =>
      startPointReady({ isRepo: true, mode: "branch", pr: null, target: null, ...o });
   it("outside a repository always", () => {
      expect(ready({ isRepo: false })).toBe(true);
   });
   it("branch mode needs a named target", () => {
      expect(ready({})).toBe(false);
      expect(ready({ target: local("main") })).toBe(true);
      expect(ready({ target: fresh("  ") })).toBe(false);
      expect(ready({ target: fresh("topic") })).toBe(true);
   });
   it("PR mode needs a picked PR, not a target", () => {
      expect(ready({ mode: "pr", target: local("main") })).toBe(false);
      expect(ready({ mode: "pr", pr: { number: 1 } })).toBe(true);
   });
});
