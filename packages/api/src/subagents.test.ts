import { describe, expect, it } from "vitest";
import { type SubagentTool, subagentState } from "./subagents";

const task = (t: Partial<SubagentTool>): SubagentTool => ({
   id: "t",
   parent: null,
   status: "completed",
   background: false,
   report: null,
   ...t,
});

describe("subagentState", () => {
   it("foreground: done when its call ends", () => {
      expect(subagentState(task({ status: null }), { calls: [], report: null })).toBe("running");
      expect(subagentState(task({}), { calls: [], report: null })).toBe("done");
   });
   it("background: done on its report", () => {
      expect(subagentState(task({ background: true }), { calls: [], report: "ok" })).toBe("done");
   });
   it("background without a report: running only while the Turn is active", () => {
      const bg = task({ background: true });
      expect(subagentState(bg, { calls: [], report: null })).toBe("running");
      expect(subagentState(bg, { calls: [], report: null }, true)).toBe("running");
      expect(subagentState(bg, { calls: [], report: null }, false)).toBe("done");
   });
   it("failed wins", () => {
      expect(subagentState(task({ status: "failed" }), { calls: [], report: null }, false)).toBe(
         "failed",
      );
   });
});
