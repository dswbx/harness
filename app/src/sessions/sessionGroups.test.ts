import type { SessionSummary, WorkspaceInfo } from "@harness/api";
import { describe, expect, it } from "vitest";
import {
   bubbledStatus,
   folderName,
   groupSessions,
   hideUnusedQuick,
   highlight,
   matches,
   nestSubSessions,
   refTitle,
   relativeTime,
   viewChanges,
} from "./sessionGroups";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 2, 12);
const ws = (o: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
   repo_root: "/r",
   source_folder: "/r",
   worktree_branch: null,
   base_branch: null,
   branch: "main",
   pr: null,
   pr_state: null,
   pr_checks: null,
   ...o,
});
const s = (
   id: string,
   folder: string,
   createdH: number,
   updatedH: number,
   o: Partial<SessionSummary> = {},
) =>
   ({
      id,
      title: id,
      folder,
      created_ms: NOW - createdH * H,
      updated_ms: NOW - updatedH * H,
      status: "idle",
      workspace: ws(),
      ...o,
   }) as SessionSummary;
const ids = (l: SessionSummary[]) => l.map((x) => x.id);

const list = [
   s("a", "/p/harness", 10, 1),
   s("b", "/p/jsonv", 1, 100),
   s("c", "/p/harness", 200, 200, { status: "needs_attention" }),
   s("d", "/p/jsonv", 1000, 900),
];

describe("groupSessions", () => {
   it("sorts by recent activity, attention first", () =>
      expect(ids(groupSessions(list, { sort: "recent", group: "none" }, NOW)[0]!.sessions)).toEqual(
         ["c", "a", "b", "d"],
      ));
   it("sorts by created", () =>
      expect(
         ids(groupSessions(list, { sort: "created", group: "none" }, NOW)[0]!.sessions),
      ).toEqual(["c", "b", "a", "d"]));
   it("groups by folder in order of each folder's newest Session", () => {
      const g = groupSessions(list, { sort: "created", group: "folder" }, NOW);
      expect(g.map((x) => [x.id, ids(x.sessions)])).toEqual([
         ["folder:jsonv", ["b", "d"]],
         ["folder:harness", ["c", "a"]],
         ["quick", []],
      ]);
   });
   it("groups by date of the sort field, skipping empty groups", () => {
      const g = groupSessions(list, { sort: "recent", group: "date" }, NOW);
      expect(g.map((x) => [x.label, ids(x.sessions)])).toEqual([
         ["Recent", ["a"]],
         ["This week", ["b"]],
         ["This month", ["c"]],
         ["Older", ["d"]],
      ]);
      expect(groupSessions(list, { sort: "created", group: "date" }, NOW).map((x) => x.id)).toEqual(
         ["date:recent", "date:month", "date:older"],
      );
   });
});

describe("search", () => {
   const pr = s("x", "/p/supalite", 1, 1, {
      title: "Fix RLS",
      workspace: ws({ branch: "rls-cases", pr: 16 }),
   });
   it("matches title, folder, branch and #pr", () => {
      for (const q of ["rls", "supalite", "cases", "#16"]) expect(matches(pr, q)).toBe(true);
      expect(matches(pr, "#17")).toBe(false);
      expect(matches(pr, "")).toBe(true);
   });
   it("highlights the first match in the title", () => {
      expect(highlight("Fix RLS policy", "rls")).toEqual(["Fix ", "RLS", " policy"]);
      expect(highlight("Fix", "zz")).toBeNull();
   });
});

describe("labels", () => {
   it("relativeTime", () => {
      expect(relativeTime(NOW - 12 * 60_000, NOW)).toBe("12m");
      expect(relativeTime(NOW - 5 * H, NOW)).toBe("5h");
      expect(relativeTime(NOW - 50 * H, NOW)).toBe("2d");
      expect(relativeTime(NOW - 22 * 24 * H, NOW)).toBe("3w");
      expect(relativeTime(Date.UTC(2026, 8, 12, 12), NOW)).toBe("Sep 12");
   });
   it("refTitle", () => {
      expect(
         refTitle(ws({ worktree_branch: "opt-in-update", branch: "opt-in-update", pr: 16 })),
      ).toBe("Worktree · opt-in-update · PR #16");
      expect(refTitle(ws())).toBe("Checked out in folder · main");
   });
   it("folderName and viewChanges", () => {
      expect(folderName("/Users/me/harness/")).toBe("harness");
      expect(viewChanges({ sort: "created", display: "condensed", group: "date" })).toBe(3);
   });
});

describe("Quick Sessions", () => {
   const quick = (id: string, updatedH: number) =>
      s(id, `/d/.harness/quick/${id}`, updatedH, updatedH, {
         quick: true,
         workspace: ws({ repo_root: null, branch: null }),
      });

   it("groups them last by folder, even when newest", () => {
      const groups = groupSessions(
         [quick("q1", 1), s("a", "/p/a", 5, 5), s("b", "/p/b", 3, 3), quick("q2", 2)],
         { sort: "recent", group: "folder" },
      );
      expect(groups.map((g) => g.label)).toEqual(["b", "a", "Quick"]);
      expect(groups.at(-1)!.sessions.map((x) => x.id)).toEqual(["q1", "q2"]);
   });

   it("keeps the Quick group when it is empty", () => {
      const groups = groupSessions([s("a", "/p/a", 5, 5)], { sort: "recent", group: "folder" });
      expect(groups.map((g) => g.id)).toEqual(["folder:a", "quick"]);
      expect(groups[1]!.quick).toBe(true);
      expect(groups[1]!.sessions).toEqual([]);
   });

   it("sorts them with the others by recency without folder grouping", () => {
      const list = [s("a", "/p/a", 5, 5), quick("q1", 1), s("b", "/p/b", 3, 3)];
      const none = groupSessions(list, { sort: "recent", group: "none" });
      expect(none.map((g) => g.id)).toEqual(["all"]);
      expect(none[0]!.sessions.map((x) => x.id)).toEqual(["q1", "b", "a"]);
      const date = groupSessions(list, { sort: "recent", group: "date" }, Date.now());
      expect(date.flatMap((g) => g.sessions.map((x) => x.id))).toEqual(["q1", "b", "a"]);
   });

   it("matches 'quick', not the folder's id", () => {
      expect(matches(quick("q1", 1), "quick")).toBe(true);
      expect(matches({ ...quick("q1", 1), title: "t" }, "q1")).toBe(false);
   });
});

describe("hideUnusedQuick", () => {
   const draft = s("draft", "/q/draft", 0, 0, { quick: true, title: "New Quick Session" });
   const used = s("used", "/q/used", 1, 1, { quick: true, title: "Convert a CSV" });
   const named = s("named", "/p/x", 1, 1, { title: "New Quick Session" });
   const l = [draft, used, named, ...list];
   it("hides Quick Sessions nobody wrote in yet (the overlay's draft)", () =>
      expect(ids(hideUnusedQuick(l, null))).toEqual(["used", "named", "a", "b", "c", "d"]));
   it("keeps the one this window has selected", () =>
      expect(ids(hideUnusedQuick(l, "draft"))).toEqual(ids(l)));
});

describe("Sub Sessions", () => {
   const sub = (id: string, parent: string, updatedH: number, o: Partial<SessionSummary> = {}) =>
      s(id, "/p/jsonv", updatedH, updatedH, {
         parent: { session_id: parent, thread_id: "t" },
         ...o,
      });
   const parent = s("p", "/p/harness", 50, 50, { title: "Parent" });
   const other = s("o", "/p/harness", 5, 5);
   const k1 = sub("k1", "p", 1, { title: "Fix RLS" });
   const k2 = sub("k2", "p", 20, { status: "needs_attention" });
   const all = [other, parent, k1, k2];

   it("nests children under their parent", () => {
      const n = nestSubSessions(all);
      expect(ids(n.roots)).toEqual(["o", "p"]);
      expect(ids(n.children.get("p")!)).toEqual(["k1", "k2"]);
   });
   it("makes a child whose parent is missing a root", () => {
      const n = nestSubSessions([other, k1]);
      expect(ids(n.roots)).toEqual(["o", "k1"]);
      expect(n.children.size).toBe(0);
   });
   it("sorts a parent by its newest child and bubbles attention", () => {
      const n = nestSubSessions([other, parent, k1]);
      const g = groupSessions(n.roots, { sort: "recent", group: "none" }, NOW, n.children);
      expect(ids(g[0]!.sessions)).toEqual(["p", "o"]);
      // Folder groups follow the parent's newest activity too.
      const f = groupSessions(n.roots, { sort: "recent", group: "folder" }, NOW, n.children);
      expect(ids(f[0]!.sessions)).toEqual(["p", "o"]);
      const withAttention = nestSubSessions([s("o2", "/p/x", 0, 0), parent, k2]);
      const g2 = groupSessions(
         withAttention.roots,
         { sort: "recent", group: "none" },
         NOW,
         withAttention.children,
      );
      expect(ids(g2[0]!.sessions)).toEqual(["p", "o2"]);
      expect(bubbledStatus(parent, withAttention.children)).toBe("needs_attention");
      expect(
         bubbledStatus(parent, new Map([["p", [sub("w", "p", 1, { status: "working" })]]])),
      ).toBe("working");
      expect(bubbledStatus(parent)).toBe("idle");
   });
   it("search: a child match shows its parent with the matching children", () => {
      const n = nestSubSessions(all, "rls");
      expect(ids(n.roots)).toEqual(["p"]);
      expect(ids(n.children.get("p")!)).toEqual(["k1"]);
   });
   it("search: a parent match keeps all its children", () => {
      const n = nestSubSessions(all, "parent");
      expect(ids(n.roots)).toEqual(["p"]);
      expect(ids(n.children.get("p")!)).toEqual(["k1", "k2"]);
      expect(ids(nestSubSessions(all, "zzz").roots)).toEqual([]);
   });
});
