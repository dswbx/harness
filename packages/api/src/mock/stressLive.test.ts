import { describe, expect, it } from "vitest";
import { stressLiveTurn } from "./stressLive";

describe("stressLiveTurn", () => {
   it("streams background subagents whose calls and reports point at their Task", () => {
      const steps = stressLiveTurn(8, 3);
      expect(steps.length).toBeGreaterThan(1500);
      expect(steps.every((s, i) => i === 0 || steps[i - 1]!.at <= s.at)).toBe(true);
      const calls = new Set<string>();
      for (const { kind } of steps) {
         if (kind.type === "ToolCall") {
            if (kind.parent_tool_call_id) expect(calls.has(kind.parent_tool_call_id)).toBe(true);
            calls.add(kind.tool_call_id);
         }
         if (kind.type === "ToolCallUpdate") expect(calls.has(kind.tool_call_id)).toBe(true);
      }
      const reports = steps.filter((s) => s.kind.type === "ToolCall" && s.kind.report);
      expect(reports).toHaveLength(8);
      // Same steps every run.
      expect(stressLiveTurn(8, 3)).toEqual(steps);
   });
});
