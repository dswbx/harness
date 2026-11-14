import { describe, expect, it } from "vitest";
import type { ChatSubagent, Tool } from "./group";
import { diffStat, type StepBody, stepView } from "./stepView";

let n = 0;
const mk = (over: Partial<Tool> = {}): Tool => ({
   type: "tool",
   id: `t${++n}`,
   title: "Tool call",
   kind: null,
   status: "completed",
   content: [],
   locations: null,
   rawInput: null,
   rawOutput: null,
   parent: null,
   background: false,
   report: null,
   harnessTool: null,
   subagentPrompt: null,
   subagentMeta: null,
   ts: 1,
   endedAt: 2,
   commitMessage: null,
   ...over,
});
const text = (t: string) => [{ type: "content", content: { type: "text", text: t } }];
const view = (
   tool: Tool,
   o: { active?: boolean; waiting?: boolean; subagent?: ChatSubagent } = {},
) =>
   stepView({ tool, subagent: o.subagent, active: o.active ?? false, waiting: o.waiting ?? false });
const agent = (calls: Tool[] = [], report: string | null = null): ChatSubagent => ({
   calls,
   steps: calls,
   report,
   endedAt: null,
});

type Row = {
   name: string;
   tool: Tool;
   opts?: Parameters<typeof view>[1];
   state: string;
   icon: string;
   verb: string;
   detail: string;
   body: StepBody["kind"];
   metas?: unknown[];
};

const rows: Row[] = [
   {
      name: "read, done, with output",
      tool: mk({ title: "Read a.ts", kind: "read", content: text("x") }),
      state: "done",
      icon: "read",
      verb: "Read",
      detail: "a.ts",
      body: "call",
      metas: [],
   },
   {
      name: "read, in progress, turn active",
      tool: mk({ title: "Read a.ts", kind: "read", status: "in_progress" }),
      opts: { active: true },
      state: "running",
      icon: "read",
      verb: "Reading",
      detail: "a.ts",
      body: "none",
      metas: [],
   },
   {
      name: "unfinished call, turn over: stopped",
      tool: mk({ title: "Read a.ts", kind: "read", status: "pending" }),
      state: "pending",
      icon: "read",
      verb: "Reading",
      detail: "a.ts",
      body: "none",
      metas: ["stopped"],
   },
   {
      name: "failed",
      tool: mk({ title: "Fetch https://x.dev", kind: "fetch", status: "failed" }),
      state: "failed",
      icon: "failed",
      verb: "Fetched",
      detail: "https://x.dev",
      body: "none",
      metas: ["failed"],
   },
   {
      name: "denied approval counts as pending",
      tool: mk({
         title: "git_push",
         harnessTool: "git_push",
         approval: "denied",
         status: "completed",
      }),
      state: "pending",
      icon: "git_push",
      verb: "Pushing",
      detail: "",
      body: "none",
      metas: ["denied"],
   },
   {
      name: "approval chip on a done call",
      tool: mk({
         title: "git_status",
         harnessTool: "git_status",
         approval: "rule",
         rawOutput: "On branch main\n3 files changed",
      }),
      state: "done",
      icon: "git_status",
      verb: "Checked status",
      detail: "",
      body: "call",
      metas: ["allowed by rule"],
   },
   {
      name: "write, with a diff stat",
      tool: mk({
         title: "Write /w/a.ts",
         kind: "edit",
         content: [{ type: "diff", path: "/w/a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" }],
      }),
      state: "done",
      icon: "edit",
      verb: "Wrote",
      detail: "/w/a.ts",
      body: "call",
      metas: [{ add: 2, del: 1 }],
   },
   {
      name: "execute",
      tool: mk({ title: "Terminal", kind: "execute", rawInput: { command: "ls" } }),
      state: "done",
      icon: "execute",
      verb: "Ran command",
      detail: "",
      body: "call",
   },
   {
      name: "mcp tool",
      tool: mk({ title: "mcp__talat__get-summary", rawInput: { a: 1 } }),
      state: "done",
      icon: "plug",
      verb: "Called talat",
      detail: "get-summary",
      body: "call",
   },
   {
      name: "unknown kind, nothing to show",
      tool: mk({ title: "Weird", kind: "other", rawInput: {}, rawOutput: [] }),
      state: "done",
      icon: "wrench",
      verb: "Called",
      detail: "Weird",
      body: "none",
   },
   {
      name: "git commit with message",
      tool: mk({
         title: "git_commit",
         harnessTool: "git_commit",
         rawInput: { message: "feat: add x\n\nbody" },
         rawOutput: "Committed abc1234567 on main",
         commitMessage: "feat: add x\n\nbody",
      }),
      state: "done",
      icon: "git_commit",
      verb: "Committed",
      detail: "feat: add x",
      body: "commit",
      metas: [],
   },
   {
      name: "git commit failed shows the error",
      tool: mk({
         title: "git_commit",
         harnessTool: "git_commit",
         status: "failed",
         rawOutput: "```\nnothing to commit\n```",
      }),
      state: "failed",
      icon: "failed",
      verb: "Commit failed",
      detail: "",
      body: "call",
      metas: ["nothing to commit"],
   },
   {
      name: "git diff counts",
      tool: mk({
         title: "git_diff",
         harnessTool: "git_diff",
         rawInput: { from: "a", to: "b" },
         rawOutput: "+x\n-y",
      }),
      state: "done",
      icon: "git_diff",
      verb: "Read diff",
      detail: "a..b",
      body: "call",
   },
   {
      name: "other harness tool",
      tool: mk({ title: "other_tool", harnessTool: "other_tool", rawInput: { a: 1 } }),
      state: "done",
      icon: "plug",
      verb: "Called Harness",
      detail: "other_tool",
      body: "call",
   },
   {
      name: "session_start",
      tool: mk({
         title: "session_start",
         harnessTool: "session_start",
         rawInput: { title: "Fix", folder: "/w/repo", prompt: "Do it" },
         rawOutput: JSON.stringify({ session_id: "s1", title: "Fix" }),
      }),
      state: "done",
      icon: "bot",
      verb: "Started sub session",
      detail: "Fix · repo",
      body: "subSession",
   },
   {
      name: "session_wait, working, took 65s",
      tool: mk({
         title: "session_wait",
         harnessTool: "session_wait",
         rawInput: { id: "s1" },
         rawOutput: JSON.stringify({
            title: "Fix",
            reply: "Done.",
            duration_ms: 65000,
            status: "working",
         }),
      }),
      state: "done",
      icon: "bot",
      verb: "Waited for sub session",
      detail: "Fix",
      body: "subSession",
      metas: ["still working", "1m 05s"],
   },
   {
      name: "session_wait with timeout 0 is a check",
      tool: mk({
         title: "session_wait",
         harnessTool: "session_wait",
         rawInput: { id: "s1", timeout_s: 0 },
         rawOutput: JSON.stringify({ title: "Fix", status: "idle" }),
      }),
      state: "done",
      icon: "bot",
      verb: "Checked sub session",
      detail: "Fix",
      body: "subSession",
      metas: [],
   },
   {
      name: "session_list counts sessions",
      tool: mk({
         title: "session_list",
         harnessTool: "session_list",
         rawOutput: JSON.stringify({ sub_sessions: [{ session_id: "s1", title: "A" }] }),
      }),
      state: "done",
      icon: "bot",
      verb: "Listed sub sessions",
      detail: "",
      body: "subSession",
      metas: ["1 sub session"],
   },
   {
      name: "session_send failed",
      tool: mk({
         title: "session_send",
         harnessTool: "session_send",
         status: "failed",
         rawInput: { id: "s1", text: "x" },
         rawOutput: "```\nsession not found\n```",
      }),
      state: "failed",
      icon: "failed",
      verb: "Send failed",
      detail: "",
      body: "subSession",
      metas: ["session not found"],
   },
   {
      name: "tool search loaded two",
      tool: mk({
         title: "ToolSearch",
         rawInput: { query: "select:Read,Edit" },
         rawOutput: [
            { type: "tool_reference", tool_name: "mcp__a__b" },
            { type: "tool_reference", tool_name: "Read" },
         ],
      }),
      state: "done",
      icon: "blocks",
      verb: "Loaded 2 tools",
      detail: "a b, Read",
      body: "toolSearch",
   },
   {
      name: "tool search by keywords, loaded none",
      tool: mk({ title: "ToolSearch", rawInput: { query: "nothing" }, rawOutput: [] }),
      state: "done",
      icon: "blocks",
      verb: "Searched tools",
      detail: '"nothing"',
      body: "call",
   },
   {
      name: "tool search running",
      tool: mk({ title: "ToolSearch", status: "in_progress", rawInput: { query: "x" } }),
      opts: { active: true },
      state: "running",
      icon: "blocks",
      verb: "Loading tools",
      detail: '"x"',
      body: "call",
   },
   {
      name: "subagent running, two calls",
      tool: mk({ title: "Explore", status: "in_progress", subagentPrompt: "p" }),
      opts: { active: true, subagent: agent([mk(), mk()]) },
      state: "running",
      icon: "bot",
      verb: "Running subagent",
      detail: "Explore",
      body: "subagent",
      metas: ["2 tool calls"],
   },
   {
      name: "subagent done with report, one call",
      tool: mk({ title: "Explore", subagentPrompt: "p" }),
      opts: { subagent: agent([mk()], "R") },
      state: "done",
      icon: "bot",
      verb: "Ran subagent",
      detail: "Explore",
      body: "subagent",
      metas: ["1 tool call"],
   },
   {
      name: "subagent failed",
      tool: mk({ title: "Explore", status: "failed" }),
      opts: { subagent: agent() },
      state: "failed",
      icon: "bot",
      verb: "Ran subagent",
      detail: "Explore",
      body: "subagent",
      metas: ["0 tool calls"],
   },
   {
      name: "background subagent without report, turn active",
      tool: mk({ title: "Bg", background: true }),
      opts: { active: true, subagent: agent([mk()]) },
      state: "running",
      icon: "bot",
      verb: "Running subagent",
      detail: "Bg",
      body: "subagent",
   },
   {
      name: "background subagent while the turn waits for the user counts as done",
      tool: mk({ title: "Bg", background: true }),
      opts: { active: true, waiting: true, subagent: agent([mk()]) },
      state: "done",
      icon: "bot",
      verb: "Ran subagent",
      detail: "Bg",
      body: "subagent",
   },
   {
      name: "subagent ignores approval",
      tool: mk({ title: "Explore", approval: "denied" }),
      opts: { subagent: agent() },
      state: "done",
      icon: "bot",
      verb: "Ran subagent",
      detail: "Explore",
      body: "subagent",
      metas: ["0 tool calls"],
   },
];

describe("stepView", () => {
   for (const r of rows) {
      it(r.name, () => {
         const v = view(r.tool, r.opts);
         expect({
            state: v.state,
            icon: v.icon,
            verb: v.verb,
            detail: v.detail,
            body: v.body.kind,
         }).toEqual({
            state: r.state,
            icon: r.icon,
            verb: r.verb,
            detail: r.detail,
            body: r.body,
         });
         if (r.metas) expect(v.metas).toEqual(r.metas);
      });
   }

   it("line status follows the state", () => {
      expect(view(mk({ status: "in_progress" }), { active: true }).lineStatus).toBe("running");
      expect(view(mk({ status: "failed" })).lineStatus).toBe("error");
      expect(view(mk({ status: "in_progress" })).lineStatus).toBe("pending");
      expect(view(mk()).lineStatus).toBeUndefined();
   });

   it("a commit message wins over the raw call view, a sub session wins over the message", () => {
      const b = view(mk({ commitMessage: "m", harnessTool: "git_commit" })).body;
      expect(b).toEqual({ kind: "commit", message: "m", hash: undefined });
   });

   it("hash comes from the commit output", () => {
      const v = view(
         mk({
            harnessTool: "git_commit",
            commitMessage: "m",
            rawOutput: "Committed abc1234567 on main",
         }),
      );
      expect(v.hash).toBe("abc1234");
      expect(v.body).toEqual({ kind: "commit", message: "m", hash: "abc1234" });
   });
});

describe("diffStat", () => {
   it("counts added and removed lines over every diff, null when none", () => {
      expect(diffStat(mk())).toBeNull();
      const d = (oldText: string | null, newText: string) => ({
         type: "diff",
         path: "p",
         oldText,
         newText,
      });
      expect(diffStat(mk({ content: [d(null, "a\nb"), d("x\n", "y\n")] }))).toEqual({
         add: 3,
         del: 1,
      });
   });
});
