import { describe, expect, it } from "vitest";
import type { Tool } from "./group";
import { stepLabel } from "./label";

const tool = (title: string, kind: string | null, harnessTool: string | null = null): Tool => ({
   type: "tool",
   id: "t",
   title,
   kind,
   status: "completed",
   content: [],
   locations: null,
   rawInput: null,
   rawOutput: null,
   parent: null,
   background: false,
   report: null,
   harnessTool,
});
const label = (t: Tool, state: "running" | "done" = "done", sub = false) => {
   const l = stepLabel(t, state, sub);
   return `${l.verb} | ${l.detail}`;
};

describe("stepLabel", () => {
   it("verb by kind and state, title prefix cut from the detail", () => {
      expect(label(tool("git status", "execute"), "running")).toBe("Running command | git status");
      expect(label(tool("git status", "execute"))).toBe("Ran command | git status");
      expect(label(tool("Terminal", "execute"))).toBe("Ran command | ");
      expect(label(tool("Read src/a.ts", "read"))).toBe("Read | src/a.ts");
      expect(label(tool("Edit src/a.ts", "edit"), "running")).toBe("Editing | src/a.ts");
      expect(label(tool("Write src/a.ts", "edit"))).toBe("Wrote | src/a.ts");
      expect(label(tool("Fetch https://x.dev", "fetch"))).toBe("Fetched | https://x.dev");
      expect(label(tool('Search "acp"', "fetch"))).toBe('Searched web | "acp"');
   });

   it("subagents, Harness and MCP tools, unknown kinds", () => {
      expect(label(tool("Find storage", "think"), "running", true)).toBe(
         "Running subagent | Find storage",
      );
      expect(label(tool("mcp__harness__render_ui", null, "render_ui"))).toBe(
         "Called Harness | render_ui",
      );
      expect(label(tool("mcp__claude_ai_Linear__get_document", null))).toBe(
         "Called claude_ai_Linear | get_document",
      );
      expect(label(tool("ToolSearch", null))).toBe("Called | ToolSearch");
   });
});
