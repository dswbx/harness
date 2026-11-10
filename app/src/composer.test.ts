import type { AgentInfo, Branches, BranchInfo, SessionSummary } from "@harness/api";
import { describe, expect, it } from "vitest";
import {
   branchChoices,
   matches,
   mergeRecent,
   quickAgent,
   relTime,
   sessionFolders,
   sourceFolders,
   tildify,
} from "./composer";

describe("composer helpers", () => {
   it("merges recent folders newest first, one per path", () => {
      const r = mergeRecent(
         [
            { path: "/a", at: 1 },
            { path: "/b/", at: 5 },
         ],
         [
            { path: "/a", at: 9 },
            { path: "/b", at: 2 },
         ],
      );
      expect(r).toEqual([
         { path: "/a", at: 9 },
         { path: "/b", at: 5 },
      ]);
   });

   it("takes Session folders, a Worktree Session's source folder instead of the Worktree", () => {
      const s = (folder: string, source: string, created_ms: number) =>
         ({
            folder,
            created_ms,
            workspace: { repo_root: null, source_folder: source, base_branch: null },
         }) as SessionSummary;
      const list = [s("/x", "/x", 3), s("/x/.harness/1/x", "/x", 4)];
      expect(sessionFolders(list)).toEqual([
         { path: "/x", at: 3 },
         { path: "/x", at: 4 },
      ]);
      expect(
         sourceFolders(
            [
               { path: "/x/.harness/1/x/", at: 9 },
               { path: "/y", at: 1 },
            ],
            list,
         ),
      ).toEqual([
         { path: "/x", at: 9 },
         { path: "/y", at: 1 },
      ]);
   });

   it("formats ages and paths", () => {
      const now = Date.UTC(2026, 9, 30, 12);
      expect(
         [30e3, 5 * 60e3, 3 * 3600e3, 30 * 3600e3, 4 * 86400e3, 15 * 86400e3].map((d) =>
            relTime(now - d, now),
         ),
      ).toEqual(["now", "5m", "3h", "Yesterday", "4d", "2w"]);
      expect([tildify("/Users/me/x/y"), tildify("/Users/me"), tildify("/opt/x")]).toEqual([
         "~/x/y",
         "~",
         "/opt/x",
      ]);
   });

   it("matches every word", () => {
      expect(matches("feat comp", "feat/composer-v2")).toBe(true);
      expect(matches("feat x", "feat/composer-v2")).toBe(false);
      expect(matches("", "anything")).toBe(true);
   });
});

describe("Quick Sessions", () => {
   const session = (o: Partial<SessionSummary>) =>
      ({
         agent_id: "a",
         created_ms: 0,
         folder: "/f",
         workspace: { worktree_branch: null },
         ...o,
      }) as SessionSummary;
   const agent = (id: string) => ({ id }) as AgentInfo;

   it("sessionFolders skips Quick Sessions", () => {
      const list = [session({ folder: "/p" }), session({ folder: "/d/quick/1", quick: true })];
      expect(sessionFolders(list).map((r) => r.path)).toEqual(["/p"]);
   });

   it("quickAgent takes the newest Session's Agent, else the first", () => {
      const agents = [agent("a"), agent("b")];
      const list = [
         session({ agent_id: "a", created_ms: 1 }),
         session({ agent_id: "b", created_ms: 2 }),
      ];
      expect(quickAgent(list, agents)?.id).toBe("b");
      expect(quickAgent([session({ agent_id: "gone" })], agents)?.id).toBe("a");
      expect(quickAgent([], agents)?.id).toBe("a");
      expect(quickAgent([], [])).toBeUndefined();
   });
});

describe("branchChoices", () => {
   const br = (name: string, worktree = false, archived = false) =>
      ({ name, time: 0, ahead: 0, behind: 0, worktree, archived }) as BranchInfo;
   const repo = (o: Partial<Branches>) =>
      ({
         repo_root: "/r",
         current: null,
         default_branch: "main",
         branches: [],
         remote: [],
         ...o,
      }) as Branches;
   const names = (l: BranchInfo[]) => l.map((x) => x.name);

   it("pins the default apart, even when not first or checked out elsewhere", () => {
      const c = branchChoices(repo({ branches: [br("a"), br("main", true), br("b")] }), "");
      expect(c.defaultLocal?.name).toBe("main");
      expect(names(c.local)).toEqual(["a", "b"]);
   });

   it("hides worktree branches unless searching", () => {
      const b = repo({ branches: [br("main"), br("wt/x", true), br("y")] });
      expect(names(branchChoices(b, "").local)).toEqual(["y"]);
      expect(names(branchChoices(b, "wt").local)).toEqual(["wt/x"]);
   });

   it("hides archived branches unless searching or current", () => {
      const b = repo({ branches: [br("main"), br("old/x", false, true), br("y")] });
      expect(names(branchChoices(b, "").local)).toEqual(["y"]);
      expect(names(branchChoices(b, "old").local)).toEqual(["old/x"]);
      const cur = repo({ current: "old/x", branches: [br("main"), br("old/x", false, true)] });
      expect(names(branchChoices(cur, "").local)).toEqual(["old/x"]);
   });

   it("puts a remote-only default in defaultRemote", () => {
      const c = branchChoices(
         repo({ default_branch: "origin/dev", branches: [br("a")], remote: [br("origin/dev")] }),
         "",
      );
      expect(c.defaultLocal).toBeUndefined();
      expect(c.defaultRemote?.name).toBe("origin/dev");
      expect(c.remote).toEqual([]);
   });

   it("drops the default when the query does not match", () => {
      const c = branchChoices(repo({ branches: [br("main"), br("feat")] }), "fe");
      expect(c.defaultLocal).toBeUndefined();
      expect(names(c.local)).toEqual(["feat"]);
   });

   it("is empty without branches", () => {
      expect(branchChoices(null, "")).toEqual({
         defaultLocal: undefined,
         defaultRemote: undefined,
         local: [],
         remote: [],
      });
   });
});
