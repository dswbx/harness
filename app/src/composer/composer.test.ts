import type { AgentInfo, Branches, BranchInfo, SessionSummary, Task } from "@harness/api";
import { describe, expect, it } from "vitest";
import {
   branchChoices,
   defaultSetStatus,
   defaultTaskParts,
   matchesWords,
   mergeRecent,
   pathsToRequest,
   quickAgent,
   sessionFolders,
   sourceFolders,
   startFromTaskArgs,
   startTaskOf,
   type TaskParts,
   taskPrompt,
   tildify,
   transcriptLabel,
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

   it("tildifies paths", () => {
      expect([tildify("/Users/me/x/y"), tildify("/Users/me"), tildify("/opt/x")]).toEqual([
         "~/x/y",
         "~",
         "/opt/x",
      ]);
   });

   it("matches every word", () => {
      expect(matchesWords("feat comp", "feat/composer-v2")).toBe(true);
      expect(matchesWords("feat x", "feat/composer-v2")).toBe(false);
      expect(matchesWords("", "anything")).toBe(true);
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

   it("quickAgent ignores unused Sessions", () => {
      const agents = [agent("a"), agent("b")];
      const used = session({ agent_id: "b", created_ms: 1 });
      const draft = session({ agent_id: "a", created_ms: 2, unused: true });
      expect(quickAgent([used, draft], agents)?.id).toBe("b");
      expect(quickAgent([draft], [agent("c"), agent("a")])?.id).toBe("c");
   });
});

describe("pathsToRequest", () => {
   it("skips paths already requested, and repeated ones", () => {
      expect(pathsToRequest(["/a", "/b", "/a", "/c"], new Set(["/b"]))).toEqual(["/a", "/c"]);
   });
   it("is empty when all were requested", () => {
      expect(pathsToRequest(["/a"], new Set(["/a"]))).toEqual([]);
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

describe("Start Session from a task", () => {
   const task = (o: Partial<Task> = {}) =>
      ({
         id: "t12",
         title: "Fix the cache",
         body: "",
         status: "todo",
         upstream: null,
         parent_id: null,
         origin_session_id: "s1",
         assets: [],
         ...o,
      }) as Task;
   const origin = (o: Partial<SessionSummary> = {}) =>
      ({
         id: "s1",
         title: "Cache work",
         folder: "/r/.harness/1/r",
         quick: false,
         workspace: { source_folder: "/r" },
         ...o,
      }) as SessionSummary;
   const all: TaskParts = {
      summary: true,
      body_and_assets: true,
      parent_and_siblings: true,
      origin_note: true,
      origin_transcript: true,
   };

   it("prompts with the title, the upstream link and the first body lines", () => {
      const body = ["a", "b", "", "c", "d", "e", "f", "g"].join("\n");
      const t = task({ body, upstream: { url: "https://linear.app/x/issue/LIN-4", label: null } });
      expect(taskPrompt(t)).toBe(
         "Fix the cache\nhttps://linear.app/x/issue/LIN-4\n\na\nb\n\nc\nd\ne",
      );
      expect(taskPrompt(task())).toBe("Fix the cache");
   });

   it("takes the origin Session's source folder, none for a Quick Session or a deleted one", () => {
      expect(startTaskOf(task(), null, [origin()]).origin?.folder).toBe("/r");
      expect(startTaskOf(task(), null, [origin({ quick: true })]).origin?.folder).toBeNull();
      expect(startTaskOf(task(), null, []).origin).toBeNull();
   });

   it("shows the parent and the upstream id under the title", () => {
      const t = task({
         parent_id: "t1",
         upstream: { url: "https://linear.app/x/issue/LIN-4", label: null },
      });
      expect(startTaskOf(t, { title: "Cache topic" }, []).detail).toBe("Cache topic · LIN-4");
   });

   it("ticks what the task has, never the origin note or chat", () => {
      const bare = startTaskOf(task(), null, [origin()]);
      expect(defaultTaskParts(bare)).toEqual({
         summary: true,
         body_and_assets: false,
         parent_and_siblings: false,
         origin_note: false,
         origin_transcript: false,
      });
      const full = startTaskOf(task({ body: "x", parent_id: "t1" }), { title: "P" }, [origin()]);
      expect(defaultTaskParts(full)).toMatchObject({
         body_and_assets: true,
         parent_and_siblings: true,
      });
   });

   it("sets In progress only on a task not started yet", () => {
      expect([
         defaultSetStatus("backlog"),
         defaultSetStatus("todo"),
         defaultSetStatus("blocked"),
      ]).toEqual(["in_progress", "in_progress", null]);
   });

   it("builds the createSession task and the first prompt", () => {
      const t = startTaskOf(task({ parent_id: "t1" }), { title: "P" }, [origin()]);
      expect(
         startFromTaskArgs({
            task: t,
            include: all,
            setStatus: "in_progress",
            title: "",
            prompt: " go \n",
         }),
      ).toEqual({
         title: "Fix the cache",
         task: { id: "t12", include: all, set_status: "in_progress" },
         prompt: "go",
      });
   });

   it("leaves out parts the task cannot give, an empty prompt and an unchanged status", () => {
      const t = startTaskOf(task({ status: "blocked" }), null, []);
      const r = startFromTaskArgs({
         task: t,
         include: all,
         setStatus: "blocked",
         title: " Mine ",
         prompt: "  ",
      });
      expect(r).toEqual({
         title: "Mine",
         task: {
            id: "t12",
            include: {
               ...all,
               parent_and_siblings: false,
               origin_note: false,
               origin_transcript: false,
            },
            set_status: null,
         },
         prompt: null,
      });
   });

   it("labels the transcript size", () => {
      expect(transcriptLabel({ kept_turns: 1, total_turns: 1 }, 640)).toBe("1 turn, 640 chars");
      expect(transcriptLabel({ kept_turns: 10, total_turns: 40 }, 23_800)).toBe(
         "last 10 of 40 turns, ~24k chars",
      );
   });
});
