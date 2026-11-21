import { describe, expect, it } from "vitest";
import type { TaskDep, TaskStatus } from "../generated";
import {
   blockedBy,
   blocks,
   childrenOf,
   dueCount,
   followedBy,
   followsOf,
   isOverdue,
   localDay,
   openBlockers,
   openCount,
   propKeys,
   topicProgress,
   upstreamId,
   webLink,
   wouldLoop,
} from "./tasks";

const t = (
   id: string,
   status: TaskStatus,
   due: string | null = null,
   parent_id: string | null = null,
   order = 1,
) => ({ id, status, due, parent_id, order });

describe("due and open counts", () => {
   const today = "2026-11-18";
   const tasks = [
      t("t1", "todo", "2026-11-17"),
      t("t2", "in_progress", "2026-11-18"),
      t("t3", "todo", "2026-11-19"),
      t("t4", "done", "2026-11-01"),
      t("t5", "cancelled", "2026-11-01"),
      t("t6", "blocked"),
   ];

   it("counts open Tasks due today or before", () => {
      expect(dueCount(tasks, today)).toBe(2);
   });

   it("counts open Tasks", () => {
      expect(openCount(tasks)).toBe(4);
   });

   it("is overdue only before today", () => {
      expect(isOverdue("2026-11-17", today)).toBe(true);
      expect(isOverdue("2026-11-18", today)).toBe(false);
      expect(isOverdue(null, today)).toBe(false);
   });

   it("formats a local day", () => {
      expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
   });
});

describe("topics", () => {
   const tasks = [
      t("t1", "todo"),
      t("t2", "done", null, "t1", 2),
      t("t3", "todo", null, "t1", 1),
      t("t4", "cancelled", null, "t1", 3),
      t("t5", "todo", null, "t3"),
   ];

   it("lists children by order", () => {
      expect(childrenOf(tasks, "t1").map((x) => x.id)).toEqual(["t3", "t2", "t4"]);
      expect(childrenOf(tasks, null).map((x) => x.id)).toEqual(["t1"]);
   });

   it("counts direct children without cancelled ones", () => {
      expect(topicProgress(tasks, "t1")).toEqual({ done: 1, total: 2 });
      expect(topicProgress(tasks, "t5")).toEqual({ done: 0, total: 0 });
   });
});

describe("upstreamId", () => {
   it.each([
      ["https://linear.app/acme/issue/ABC-123/fix-login", "ABC-123"],
      ["https://linear.app/acme/issue/abc-7", "ABC-7"],
      ["https://github.com/dswbx/harness/issues/42", "#42"],
      ["https://github.com/dswbx/harness/pull/190#discussion", "#190"],
      ["https://github.com/dswbx/harness", null],
      ["https://example.com/issue/ABC-1", null],
      ["not a url", null],
   ])("%s", (url, id) => {
      expect(upstreamId(url)).toBe(id);
   });
});

describe("webLink", () => {
   it.each([
      ["https://linear.app/x/issue/ABC-1", "https://linear.app/x/issue/ABC-1"],
      [" HTTP://localhost:3000/a ", "HTTP://localhost:3000/a"],
      ["linear.app/x/issue/ABC-1", "https://linear.app/x/issue/ABC-1"],
      ["localhost:3000/a", "https://localhost:3000/a"],
      ["javascript:alert(1)", null],
      ["file:///etc/passwd", null],
      ["ftp://x", null],
      ["https://", null],
      ["https:// a", null],
      ["two words", null],
      ["  ", null],
   ])("%s", (input, out) => {
      expect(webLink(input)).toBe(out);
   });
});

describe("dependencies", () => {
   const g = (
      id: string,
      deps: TaskDep[] = [],
      status: TaskStatus = "todo",
      props: Record<string, string> = {},
   ) => ({ id, deps, status, props });
   const b = (id: string): TaskDep => ({ id, kind: "blocks" });
   const f = (id: string): TaskDep => ({ id, kind: "follow_up" });
   // a <- b <- c (b waits on a, c waits on b); d follows a; c also waits on a missing task.
   const tasks = [
      g("a", [], "done", { component: "alpha" }),
      g("b", [b("a")], "in_progress", { component: "beta", area: "x" }),
      g("c", [b("b"), b("gone"), f("a")]),
      g("d", [f("a"), b("c")], "todo", { component: "alpha" }),
   ];

   it("blockedBy and blocks", () => {
      expect(blockedBy(tasks, "c").map((x) => x.id)).toEqual(["b"]);
      expect(blocks(tasks, "a").map((x) => x.id)).toEqual(["b"]);
      expect(blocks(tasks, "c").map((x) => x.id)).toEqual(["d"]);
      expect(blockedBy(tasks, "nope")).toEqual([]);
   });

   it("followsOf and followedBy", () => {
      expect(followsOf(tasks, "d").map((x) => x.id)).toEqual(["a"]);
      expect(followedBy(tasks, "a").map((x) => x.id)).toEqual(["c", "d"]);
      expect(followsOf(tasks, "b")).toEqual([]);
   });

   it("openBlockers counts blockers not done or cancelled", () => {
      expect(openBlockers(tasks, "b")).toBe(0);
      expect(openBlockers(tasks, "c")).toBe(1);
      expect(openBlockers([...tasks, g("e", [b("a"), b("c")])], "e")).toBe(1);
      expect(openBlockers([g("x", [b("y")]), g("y", [], "cancelled")], "x")).toBe(0);
   });

   it("wouldLoop sees self, direct and long loops of either kind", () => {
      expect(wouldLoop(tasks, "a", "a")).toBe(true);
      expect(wouldLoop(tasks, "a", "b")).toBe(true);
      expect(wouldLoop(tasks, "a", "d")).toBe(true);
      expect(wouldLoop(tasks, "b", "d")).toBe(true);
      expect(wouldLoop(tasks, "d", "a")).toBe(false);
      expect(wouldLoop(tasks, "c", "a")).toBe(false);
      expect(wouldLoop(tasks, "a", "zzz")).toBe(false);
   });

   it("wouldLoop stops on bad data with a loop", () => {
      const bad = [g("p", [b("q")]), g("q", [b("p")]), g("r")];
      expect(wouldLoop(bad, "r", "p")).toBe(false);
   });

   it("propKeys is sorted and unique", () => {
      expect(propKeys(tasks)).toEqual(["area", "component"]);
      expect(propKeys([])).toEqual([]);
   });
});
