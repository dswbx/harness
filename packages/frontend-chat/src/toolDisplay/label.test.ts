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
   subagentPrompt: null,
   subagentMeta: null,
   ts: 0,
   endedAt: null,
   commitMessage: null,
});
const label = (t: Tool, state: "running" | "done" | "failed" = "done", sub = false) => {
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

   it("Harness git tools: verb by state, detail from the call", () => {
      const git = (name: string, rawInput: unknown, rawOutput: unknown = null): Tool => ({
         ...tool(`mcp__harness__${name}`, null, name),
         rawInput,
         rawOutput,
      });
      const hex = "b".repeat(40);
      const commit = git("git_commit", { message: "Fix it\n\nbody" }, [
         { type: "text", text: `Committed ${hex}` },
      ]);
      expect(label(commit, "running")).toBe("Committing | Fix it");
      expect(label(commit)).toBe("Committed | Fix it");
      expect(label(commit, "failed")).toBe("Commit failed | Fix it");
      const push = git("git_push", {}, [{ type: "text", text: "Pushed feat/x." }]);
      expect(label(push)).toBe("Pushed | feat/x → origin");
      expect(label(git("git_push", {}), "running")).toBe("Pushing | ");
      expect(label(git("git_push", {}, "Pushed."))).toBe("Pushed | ");
      expect(label(git("git_diff", { from: "main", to: "HEAD" }))).toBe("Read diff | main..HEAD");
      expect(label(git("git_diff", {}), "running")).toBe("Reading diff | working tree");
      expect(label(git("list_branches", {}), "failed")).toBe("List failed | ");
      expect(
         label(git("git_status", {}, [{ type: "text", text: '{"branch":"main","files":[]}' }])),
      ).toBe("Checked status | main");
   });
});
