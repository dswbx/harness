import type { TaskSummary } from "@harness/api";
import { describe, expect, it } from "vitest";
import {
   ancestors,
   compareTasks,
   descendantIds,
   parentCandidates,
   sessionTasks,
   sortTasks,
   splitDone,
   taskFromText,
} from "./listModel";

const t = (id: string, o: Partial<TaskSummary> = {}): TaskSummary => ({
   id,
   title: id,
   has_body: false,
   status: "todo",
   priority: "none",
   due: null,
   upstream: null,
   parent_id: null,
   order: 1,
   origin_session_id: null,
   origin_title: null,
   sessions: [],
   assets: [],
   created_ms: 0,
   updated_ms: 0,
   ...o,
});

const ids = (l: { id: string }[]) => l.map((x) => x.id);

describe("sortTasks", () => {
   it("sorts by status, then priority, then due date, then age", () => {
      const list = [
         t("backlog", { status: "backlog" }),
         t("todo-low", { priority: "low" }),
         t("todo-urgent", { priority: "urgent" }),
         t("todo-due-late", { due: "2026-12-01" }),
         t("todo-due-soon", { due: "2026-11-20" }),
         t("todo-old", { created_ms: -1 }),
         t("doing", { status: "in_progress" }),
         t("done", { status: "done", priority: "urgent" }),
      ];
      expect(ids(sortTasks(list))).toEqual([
         "doing",
         "todo-urgent",
         "todo-low",
         "todo-due-soon",
         "todo-due-late",
         "todo-old",
         "backlog",
         "done",
      ]);
   });

   it("keeps equal tasks equal", () => {
      expect(compareTasks(t("a"), t("b"))).toBe(0);
   });
});

describe("splitDone", () => {
   it("puts done and cancelled tasks apart", () => {
      const r = splitDone([
         t("a", { status: "done" }),
         t("b"),
         t("c", { status: "cancelled" }),
         t("d", { status: "blocked" }),
      ]);
      expect(ids(r.open)).toEqual(["d", "b"]);
      expect(ids(r.closed)).toEqual(["a", "c"]);
   });
});

describe("sessionTasks", () => {
   const link = (session_id: string, started_ms: number) => ({ session_id, title: "", started_ms });
   it("pins the task the Session was last started from and lists the others created in it", () => {
      const r = sessionTasks(
         [
            t("mine", { origin_session_id: "s1" }),
            t("other", { origin_session_id: "s2" }),
            t("old-start", { sessions: [link("s1", 1)] }),
            t("pin", { origin_session_id: "s1", sessions: [link("s2", 9), link("s1", 5)] }),
         ],
         "s1",
      );
      expect(r.pinned?.id).toBe("pin");
      expect(ids(r.created)).toEqual(["mine"]);
   });

   it("has no pin when no task started the Session", () => {
      expect(sessionTasks([t("a", { origin_session_id: "s1" })], "s1").pinned).toBeNull();
   });
});

describe("tree helpers", () => {
   const list = [
      t("root"),
      t("a", { parent_id: "root" }),
      t("a1", { parent_id: "a" }),
      t("b", { parent_id: "root" }),
      t("loose"),
   ];
   it("finds every descendant", () => {
      expect([...descendantIds(list, "root")].sort()).toEqual(["a", "a1", "b"]);
      expect(descendantIds(list, "loose").size).toBe(0);
   });

   it("offers as parents neither the task nor its descendants", () => {
      expect(ids(parentCandidates(list, "a")).sort()).toEqual(["b", "loose", "root"]);
   });

   it("lists ancestors top first and stops at a loop", () => {
      const byId = new Map(list.map((x) => [x.id, x]));
      expect(ids(ancestors(byId, "a1"))).toEqual(["root", "a"]);
      const loop = new Map([
         ["x", t("x", { parent_id: "y" })],
         ["y", t("y", { parent_id: "x" })],
      ]);
      expect(ids(ancestors(loop, "x"))).toEqual(["y"]);
   });
});

describe("taskFromText", () => {
   it("takes the first line as the title and the rest as the body", () => {
      expect(taskFromText("\n- Check disk use\n  after a week\n")).toEqual({
         title: "Check disk use",
         body: "after a week",
      });
      expect(taskFromText("One line")).toEqual({ title: "One line", body: null });
      expect(taskFromText("  \n ")).toBeNull();
   });
});
