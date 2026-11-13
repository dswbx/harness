import { describe, expect, it } from "vitest";
import { listSubagents, type SubagentTool, subagentState } from "./subagents";

const task = (t: Partial<SubagentTool>): SubagentTool => ({
   id: "t",
   parent: null,
   status: "completed",
   background: false,
   report: null,
   ...t,
});

const sub = (report: string | null) => ({ calls: [], steps: [], report, endedAt: null });

describe("subagentState", () => {
   it("foreground: done when its call ends", () => {
      expect(subagentState(task({ status: null }), sub(null))).toBe("running");
      expect(subagentState(task({}), sub(null))).toBe("done");
   });
   it("background: done on its report", () => {
      expect(subagentState(task({ background: true }), sub("ok"))).toBe("done");
   });
   it("background without a report: running only while the Turn is active", () => {
      const bg = task({ background: true });
      expect(subagentState(bg, sub(null))).toBe("running");
      expect(subagentState(bg, sub(null), true)).toBe("running");
      expect(subagentState(bg, sub(null), false)).toBe("done");
   });
   it("failed wins", () => {
      expect(subagentState(task({ status: "failed" }), sub(null), false)).toBe("failed");
   });
});

describe("listSubagents", () => {
   const t = (id: string, ts: number, x: Partial<SubagentTool> = {}) => ({
      ...task({ id, ts, ...x }),
      title: `task ${id}`,
      subagentMeta: { type: "Explore", model: "haiku", modelInherited: false, effort: "high" },
   });
   const s = (calls: number, endedAt: number | null = null) => ({
      calls: Array.from({ length: calls }, (_, i) => task({ id: `c${i}` })),
      steps: [],
      report: null,
      endedAt,
   });

   it("lists subagents with their meta, running first, then newest first", () => {
      const tools = [
         t("a", 1),
         t("b", 2),
         t("c", 3, { status: "failed" }),
         t("d", 4, { status: null }),
         t("plain", 5),
      ];
      const subs = new Map([
         ["a", s(2, 10)],
         ["b", s(1, 20)],
         ["c", s(0)],
         ["d", s(3)],
      ]);
      const rows = listSubagents(tools, subs);
      expect(rows.map((r) => [r.id, r.state])).toEqual([
         ["d", "running"],
         ["c", "failed"],
         ["b", "done"],
         ["a", "done"],
      ]);
      expect(rows[3]).toEqual({
         id: "a",
         title: "task a",
         type: "Explore",
         model: "haiku",
         modelInherited: false,
         effort: "high",
         calls: 2,
         state: "done",
         startedAt: 1,
         endedAt: 10,
      });
   });

   it("skips subagents whose starting call is unknown; missing meta is null", () => {
      const rows = listSubagents(
         [{ ...task({ id: "x" }), title: "x" }],
         new Map([
            ["x", s(0)],
            ["gone", s(1)],
         ]),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: null, model: null, effort: null, startedAt: null });
   });

   it("background without a report is done once the Turn stops", () => {
      const rows = listSubagents(
         [t("bg", 1, { background: true })],
         new Map([["bg", s(0)]]),
         false,
      );
      expect(rows[0]!.state).toBe("done");
   });
});
