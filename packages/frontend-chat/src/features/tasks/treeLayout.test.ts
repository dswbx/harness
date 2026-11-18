import type { TaskSummary } from "@harness/api";
import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER } from "./listModel";
import { type Box, collapseAll, layoutTree, revealNode, type TreeOptions } from "./treeLayout";

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

// Two topics (a with a nested topic a1), and two top-level tasks without subtasks.
const TASKS = [
   t("a"),
   t("a1", { parent_id: "a" }),
   t("a1x", { parent_id: "a1" }),
   t("a1y", { parent_id: "a1", status: "done" }),
   t("a2", { parent_id: "a", status: "done" }),
   t("b"),
   t("b1", { parent_id: "b" }),
   t("loose1"),
   t("loose2", { status: "done" }),
];

const opts = (o: Partial<TreeOptions> = {}): TreeOptions => ({
   filter: DEFAULT_FILTER,
   today: "2026-11-18",
   hideDone: false,
   collapsed: new Set(),
   ...o,
});

const shown = (o?: Partial<TreeOptions>, tasks = TASKS) =>
   layoutTree(tasks, opts(o)).nodes.map((n) => n.task.id);

const overlap = (a: Box, b: Box) =>
   a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layoutTree", () => {
   it("shows only topics at the top level, then their subtasks, and counts the rest", () => {
      const l = layoutTree(TASKS, opts());
      expect(l.nodes.map((n) => n.task.id)).toEqual(["a", "a1", "a1x", "a1y", "a2", "b", "b1"]);
      expect(l.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 2, 1, 0, 1]);
      // loose1 and loose2 (closed tasks count too: the status filter is not the tree's).
      expect(l.loose).toBe(2);
      expect(l.root).not.toBeNull();
      expect(l.edges.filter((e) => e.from === null).map((e) => e.to)).toEqual(["a", "b"]);
      expect(l.edges.filter((e) => e.from === "a1").map((e) => e.to)).toEqual(["a1x", "a1y"]);
   });

   it("no topic: no root and nothing laid out", () => {
      const l = layoutTree([t("x"), t("y")], opts());
      expect(l.root).toBeNull();
      expect(l.nodes).toEqual([]);
      expect(l.loose).toBe(2);
   });

   it("a folded task hides what is below it and counts it", () => {
      const l = layoutTree(TASKS, opts({ collapsed: new Set(["a"]) }));
      expect(l.nodes.map((n) => n.task.id)).toEqual(["a", "b", "b1"]);
      const a = l.nodes[0];
      expect(a?.expanded).toBe(false);
      expect(a?.hidden).toBe(4);
      expect(a?.kids).toBe(2);
      const nested = layoutTree(TASKS, opts({ collapsed: new Set(["a1"]) }));
      expect(nested.nodes.find((n) => n.task.id === "a1")?.hidden).toBe(2);
      expect(nested.nodes.find((n) => n.task.id === "a")?.hidden).toBe(0);
   });

   it("Collapse all folds every task with subtasks; Expand all is the empty set", () => {
      const all = collapseAll(TASKS);
      expect([...all].sort()).toEqual(["a", "a1", "b"]);
      expect(shown({ collapsed: all })).toEqual(["a", "b"]);
      expect(shown({ collapsed: new Set() })).toEqual(["a", "a1", "a1x", "a1y", "a2", "b", "b1"]);
   });

   it("Hide done drops closed tasks unless an open one is below them", () => {
      expect(shown({ hideDone: true })).toEqual(["a", "a1", "a1x", "b", "b1"]);
      expect(layoutTree(TASKS, opts({ hideDone: true })).loose).toBe(1);
      const doneTopic = [
         t("d", { status: "done" }),
         t("d1", { parent_id: "d" }),
         t("e", { status: "done" }),
         t("e1", { parent_id: "e", status: "cancelled" }),
      ];
      const l = layoutTree(doneTopic, opts({ hideDone: true }));
      expect(l.nodes.map((n) => [n.task.id, n.context])).toEqual([
         ["d", true],
         ["d1", false],
      ]);
   });

   it("filters keep the path to a match as context", () => {
      const filter = { ...DEFAULT_FILTER, query: "a1x" };
      const l = layoutTree(TASKS, opts({ filter }));
      expect(l.nodes.map((n) => [n.task.id, n.context])).toEqual([
         ["a", true],
         ["a1", true],
         ["a1x", false],
      ]);
      expect(l.loose).toBe(0);
   });

   it("lays out left to right without overlapping boxes", () => {
      const many = [
         ...TASKS,
         ...Array.from({ length: 6 }, (_, i) => t(`b1-${i}`, { parent_id: "b1" })),
         t("c"),
         t("c1", { parent_id: "c" }),
         t("c2", { parent_id: "c" }),
      ];
      for (const collapsed of [new Set<string>(), new Set(["a1"]), collapseAll(many)]) {
         const l = layoutTree(many, opts({ collapsed }));
         const boxes: Box[] = [...l.nodes, ...(l.root ? [l.root] : [])];
         for (const [i, a] of boxes.entries())
            for (const b of boxes.slice(i + 1))
               expect(overlap(a, b), JSON.stringify([a, b])).toBe(false);
         for (const n of l.nodes) {
            expect(n.x + n.w).toBeLessThanOrEqual(l.width);
            expect(n.y + n.h).toBeLessThanOrEqual(l.height);
         }
         // Children to the right of their parent, deeper is further right.
         for (const e of l.edges) expect(e.x2).toBeGreaterThan(e.x1);
         const xs = new Map(l.nodes.map((n) => [n.depth, n.x]));
         for (const n of l.nodes) expect(n.x).toBe(xs.get(n.depth));
      }
   });

   it("a parent sits at the middle of its children", () => {
      const l = layoutTree(TASKS, opts());
      const at = (id: string) => l.nodes.find((n) => n.task.id === id) as Box;
      expect(at("a1").y).toBe((at("a1x").y + at("a1y").y) / 2);
   });
});

describe("revealNode", () => {
   const byId = new Map(TASKS.map((x) => [x.id, x]));
   it("unfolds the ancestors of a task", () => {
      const next = revealNode(byId, "a1x", new Set(["a", "a1", "b"]));
      expect([...next]).toEqual(["b"]);
   });
   it("returns the same set when nothing is folded above it", () => {
      const same = new Set(["b"]);
      expect(revealNode(byId, "a1x", same)).toBe(same);
   });
});
