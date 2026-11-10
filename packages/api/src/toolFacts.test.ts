import { describe, expect, it } from "vitest";
import { toolFacts } from "./toolFacts";

describe("toolFacts (fallback for logs without the typed fields)", () => {
   it("reads a plan from a mode switch only", () => {
      expect(toolFacts({ kind: "switch_mode", rawInput: { plan: "# P" } }).plan).toBe("# P");
      expect(toolFacts({ kind: "execute", rawInput: { plan: "# P" } }).plan).toBeNull();
      expect(toolFacts({ kind: "switch_mode", rawInput: {} }).plan).toBeNull();
   });

   it("reads a subagent prompt from a Task-shaped input", () => {
      const task = { description: "d", prompt: "Look", subagent_type: "Explore" };
      expect(toolFacts({ rawInput: task }).subagentPrompt).toBe("Look");
      expect(toolFacts({ rawInput: { prompt: "hi" } }).subagentPrompt).toBeNull();
      expect(toolFacts({ rawInput: null }).subagentPrompt).toBeNull();
   });

   it("reads the commit message of git_commit", () => {
      expect(toolFacts({ kind: "git_commit", rawInput: { message: " Fix\n" } }).commitMessage).toBe(
         "Fix",
      );
      expect(
         toolFacts({ harnessTool: "git_commit", rawInput: { message: "Fix" } }).commitMessage,
      ).toBe("Fix");
      expect(
         toolFacts({ harnessTool: "git_push", rawInput: { message: "x" } }).commitMessage,
      ).toBeNull();
   });

   it("names a Frontend Tool from the title or the Harness tool", () => {
      expect(
         toolFacts({ kind: "frontend_tool", title: "Frontend tool: render_ui" }).frontendTool,
      ).toBe("render_ui");
      expect(
         toolFacts({ kind: "frontend_tool", title: "x", harnessTool: "render_ui" }).frontendTool,
      ).toBe("render_ui");
      expect(toolFacts({ kind: "execute", title: "Frontend tool: x" }).frontendTool).toBeNull();
   });
});
