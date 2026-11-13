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
