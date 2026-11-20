import type { TaskSummary } from "@harness/api";
import { describe, expect, it } from "vitest";
import {
   ancestors,
   buildList,
   canNest,
   compareTasks,
   DEFAULT_FILTER,
   descendantIds,
   type GroupBy,
   groupProp,
   hasFilters,
   type ListGroup,
   matchesFilter,
   moveTargets,
   NO_SESSION,
   parentCandidates,
   parseGroupBy,
   reveal,
   sessionCount,
   sessionTasks,
   sortTasks,
   splitDone,
   type TaskFilter,
   taskFromText,
} from "./listModel";

const t = (id: string, o: Partial<TaskSummary> = {}): TaskSummary => ({
   id,
   title: id,
   has_body: false,
   excerpt: "",
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
   deps: [],
   props: {},
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

describe("All tasks list", () => {
   const today = "2026-11-18";
   // Topic a (a1, a2 done, a3 with a31), topic b (b1 done only), loose c (done) and d.
   const tasks = [
      t("a", { title: "Alpha" }),
      t("a1", { parent_id: "a", priority: "high", origin_session_id: "s1" }),
      t("a2", { parent_id: "a", status: "done" }),
      t("a3", { parent_id: "a", due: "2026-11-10" }),
      t("a31", { parent_id: "a3", upstream: { url: "https://x.dev/1", label: null } }),
      t("b", { title: "Beta", status: "done" }),
      t("b1", { parent_id: "b", status: "done" }),
      t("c", { status: "cancelled" }),
      t("d", { title: "Delta", due: "2026-11-20", origin_session_id: "s2" }),
   ];
   const list = (
      filter: Partial<TaskFilter> = {},
      groupBy: GroupBy = "topic",
      flipped = new Set<string>(),
   ) => buildList(tasks, { filter: { ...DEFAULT_FILTER, ...filter }, groupBy, today, flipped });
   const shape = (g: ListGroup<{ id: string }>) => ({
      key: g.key,
      head: g.head?.task.id ?? null,
      rows: g.rows.map((r) => `${"-".repeat(r.depth)}${r.task.id}`),
      count: g.count,
   });

   it("groups by topic, with the open subtasks indented and the loose tasks under No topic", () => {
      const l = list();
      expect(l.groups.map(shape)).toEqual([
         // a3 has a subtask: folded by default, its subtask still counts.
         { key: "a", head: "a", rows: ["-a1", "-a3"], count: 3 },
         { key: "none", head: null, rows: ["d"], count: 1 },
      ]);
      expect(l.groups[1]?.label).toBe("No topic");
      expect(l.groups[0]?.rows[1]).toMatchObject({ kids: 1, expanded: false });
      // Open filter: closed tasks (and a closed topic with no open subtask) go to the folded group.
      expect(ids(l.closed)).toEqual(["a2", "b", "b1", "c"]);
   });

   it("expands and folds by the flipped ids", () => {
      const l = list({}, "topic", new Set(["a3", "group:none"]));
      expect(shape(l.groups[0] as ListGroup<{ id: string }>).rows).toEqual(["-a1", "-a3", "--a31"]);
      expect(l.groups[1]).toMatchObject({ folded: true, rows: [], count: 1 });
      const folded = list({}, "topic", new Set(["a"]));
      expect(folded.groups[0]).toMatchObject({ folded: true, rows: [], count: 3 });
   });

   it("shows all statuses in place with status all, and only closed ones with done", () => {
      const all = list({ status: "all" });
      expect(all.groups.map(shape)).toEqual([
         { key: "a", head: "a", rows: ["-a1", "-a3", "-a2"], count: 4 },
         { key: "b", head: "b", rows: ["-b1"], count: 1 },
         { key: "none", head: null, rows: ["d", "c"], count: 2 },
      ]);
      expect(all.closed).toEqual([]);
      const done = list({ status: "done" });
      expect(done.groups.map(shape)).toEqual([
         { key: "a", head: "a", rows: ["-a2"], count: 1 },
         { key: "b", head: "b", rows: ["-b1"], count: 1 },
         { key: "none", head: null, rows: ["c"], count: 1 },
      ]);
      // The open topic shows only for its done subtask.
      expect(done.groups[0]?.head?.context).toBe(true);
   });

   it("keeps a topic and its path for a matching subtask", () => {
      const l = list({ upstream: true });
      expect(l.groups.map(shape)).toEqual([{ key: "a", head: "a", rows: ["-a3"], count: 1 }]);
      expect(l.groups[0]?.head?.context).toBe(true);
      expect(l.groups[0]?.rows[0]?.context).toBe(true);
   });

   it("groups flat by status and by origin Session", () => {
      const status = list({ status: "all" }, "status");
      expect(status.groups.map((g) => [g.key, ids(g.rows.map((r) => r.task))])).toEqual([
         ["todo", ["a1", "a3", "d", "a", "a31"]],
         ["done", ["a2", "b", "b1"]],
         ["cancelled", ["c"]],
      ]);
      const bySession = buildList(tasks, {
         filter: DEFAULT_FILTER,
         groupBy: "session",
         today,
         flipped: new Set(),
         sessionTitle: (id) => (id === "s2" ? "Beta work" : null),
      });
      expect(bySession.groups.map((g) => [g.label, g.count])).toEqual([
         ["Beta work", 1],
         ["Session", 1],
         ["No session", 3],
      ]);
   });

   it("puts each task in one place in flat groups, also a closed task with open subtasks", () => {
      // x is done but its subtask x1 is open.
      const mixed = [
         t("x", { status: "done", origin_session_id: "s1" }),
         t("x1", { parent_id: "x", origin_session_id: "s1" }),
         t("y"),
      ];
      for (const groupBy of ["status", "session"] as const) {
         const l = buildList(mixed, { filter: DEFAULT_FILTER, groupBy, today, flipped: new Set() });
         const placed = [
            ...l.groups.flatMap((g) => g.rows.map((r) => r.task.id)),
            ...ids(l.closed),
         ];
         expect(placed.sort(), groupBy).toEqual(["x", "x1", "y"]);
         expect(ids(l.closed), groupBy).toEqual(["x"]);
      }
   });

   it("groups flat by a prop key, sorted by value, with No <key> last", () => {
      const withProps = [
         t("p1", { props: { area: "parser" } }),
         t("p2", { props: { area: "cli", team: "core" } }),
         t("p3", { props: { team: "core" } }),
         t("p4", { props: { area: "parser" } }),
         t("p5", { status: "done", props: { area: "zeta" } }),
         // A prop key that is also an Object.prototype name.
         t("p6", { props: { constructor: "x" } }),
      ];
      const l = buildList(withProps, {
         filter: DEFAULT_FILTER,
         groupBy: "prop:area",
         today,
         flipped: new Set(),
      });
      expect(l.groups.map((g) => [g.label, ids(g.rows.map((r) => r.task))])).toEqual([
         ["cli", ["p2"]],
         ["parser", ["p1", "p4"]],
         ["No area", ["p3", "p6"]],
      ]);
      // A value's group key cannot clash with the "No area" group, even for the value "none".
      expect(l.groups.map((g) => g.key)).toEqual(["=cli", "=parser", "none"]);
      expect(ids(l.closed)).toEqual(["p5"]);
      const odd = buildList(withProps, {
         filter: DEFAULT_FILTER,
         groupBy: "prop:constructor",
         today,
         flipped: new Set(["group:none"]),
      });
      expect(odd.groups.map((g) => [g.label, g.count, g.folded])).toEqual([
         ["x", 1, false],
         ["No constructor", 4, true],
      ]);
   });

   it("parses a stored group-by: fields, prop keys, and anything else as topic", () => {
      expect(parseGroupBy("topic")).toBe("topic");
      expect(parseGroupBy("status")).toBe("status");
      expect(parseGroupBy("session")).toBe("session");
      expect(parseGroupBy("prop:component")).toBe("prop:component");
      expect(groupProp("prop:component")).toBe("component");
      expect(groupProp("status")).toBeNull();
      for (const bad of [null, "", "priority", "prop:", "prop:Has Space", `prop:${"k".repeat(33)}`])
         expect(parseGroupBy(bad), String(bad)).toBe("topic");
   });

   it("filters by priority, Session, due date, upstream and text", () => {
      const f = (o: Partial<TaskFilter>) =>
         tasks.filter((x) => matchesFilter(x, { ...DEFAULT_FILTER, ...o }, today)).map((x) => x.id);
      expect(f({ priorities: ["high"] })).toEqual(["a1"]);
      expect(f({ session: "s2" })).toEqual(["d"]);
      expect(f({ session: NO_SESSION })).not.toContain("a1");
      expect(f({ due: "overdue" })).toEqual(["a3"]);
      expect(f({ due: "today" })).toEqual(["a3"]);
      expect(f({ due: "week" })).toEqual(["a3", "d"]);
      expect(f({ due: "none" })).not.toContain("d");
      expect(f({ upstream: true })).toEqual(["a31"]);
      expect(f({ query: "  delta " })).toEqual(["d"]);
      expect(f({ query: "A31" })).toEqual(["a31"]);
      expect(hasFilters(DEFAULT_FILTER)).toBe(false);
      expect(hasFilters({ ...DEFAULT_FILTER, status: "all" })).toBe(false);
      expect(hasFilters({ ...DEFAULT_FILTER, due: "week" })).toBe(true);
   });

   it("offers the topics a task can move under, and checks a drop", () => {
      expect(ids(moveTargets(tasks, "d"))).toEqual(["a", "b"]);
      // Not its own parent, not itself.
      expect(ids(moveTargets(tasks, "a1"))).toEqual(["b"]);
      expect(ids(moveTargets(tasks, "a"))).toEqual(["b"]);
      expect(canNest(tasks, "d", "a")).toBe(true);
      expect(canNest(tasks, "a", "a31")).toBe(false);
      expect(canNest(tasks, "a1", "a")).toBe(false);
      expect(canNest(tasks, "a1", null)).toBe(true);
      expect(canNest(tasks, "d", null)).toBe(false);
   });

   it("reveals a nested task by expanding its ancestors", () => {
      const byId = new Map(tasks.map((x) => [x.id, x]));
      const flipped = new Set(["a"]);
      expect([...reveal(byId, "a31", flipped)]).toEqual(["a3"]);
      const open = new Set(["a3"]);
      expect(reveal(byId, "a31", open)).toBe(open);
   });

   it("counts the Sessions of open tasks", () => {
      expect(sessionCount(tasks)).toBe(2);
   });
});
