import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Event, groupSubagents } from "@harness/api";
import { TooltipProvider } from "@harness/ui";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../../state/reducer";
import { reduceBatch } from "../renderUi/chatReducer";
import type { ChatSubagent, Step, Tool } from "./group";
import { OpenStep } from "./openStep";
import { TraceDisplay } from "./TraceDisplay";
import { WaitingForUser } from "./waiting";

// Records what the Trace display renders, so a refactor of it can prove it changed nothing.
// Tool calls: those of the golden Session Logs folded through the reducer, plus variants of them
// (the logs have no approvals, Sub Session tools, tool search or subagents).
const dir = join(__dirname, "../../../../../crates/harness-core/tests/golden");

const golden: Tool[] = readdirSync(dir)
   .filter((f) => f.endsWith(".jsonl"))
   .sort()
   .flatMap((name) => {
      const events = readFileSync(join(dir, name), "utf8")
         .split("\n")
         .filter((l) => l.trim())
         .map((l) => JSON.parse(l) as Event);
      return reduceBatch(initialState(), events)
         .items.filter((i): i is Tool => i.type === "tool")
         .map((t) => ({ ...t, id: `${name}:${t.id}` }));
   });

// One of each kind of golden call gets the status and approval variants.
const distinct = golden.filter(
   (t, i) => golden.findIndex((o) => o.kind === t.kind && o.harnessTool === t.harnessTool) === i,
);

let n = 0;
const mk = (over: Partial<Tool>): Tool => ({
   type: "tool",
   id: `x${++n}`,
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
   ts: 1000,
   endedAt: 2000,
   commitMessage: null,
   ...over,
});
const text = (t: string) => [{ type: "content", content: { type: "text", text: t } }];
const withStatus = (t: Tool, status: string | null, over: Partial<Tool> = {}): Tool => ({
   ...t,
   id: `${t.id}-${status}-${over.approval ?? "none"}`,
   status,
   ...over,
});

const variants: Tool[] = [
   ...golden,
   ...distinct.flatMap((t) => [
      withStatus(t, "in_progress"),
      withStatus(t, "pending"),
      withStatus(t, "failed"),
      withStatus(t, "completed", { approval: "you" }),
      withStatus(t, "completed", { approval: "rule" }),
      withStatus(t, "completed", { approval: "auto" }),
      withStatus(t, "completed", { approval: "denied" }),
   ]),
   mk({
      title: "Edit a.ts",
      kind: "edit",
      content: [{ type: "diff", path: "/w/a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" }],
   }),
   mk({ title: "Write /w/new.ts", kind: "edit", locations: [{ path: "/w/new.ts" }] }),
   mk({
      title: "Terminal",
      kind: "execute",
      rawInput: { command: "ls -la" },
      content: text("a\nb"),
   }),
   mk({ title: "Fetch https://x.dev", kind: "fetch" }),
   mk({ title: 'Search "q"', kind: "search", rawOutput: { hits: 1 } }),
   mk({ title: "mcp__talat__get-summary", rawInput: { a: 1 }, rawOutput: "plain" }),
   mk({ title: "Plan", kind: "think" }),
   mk({ title: "Switch", kind: "switch_mode" }),
   mk({ title: "Rm", kind: "delete" }),
   mk({ title: "Mv", kind: "move" }),
   mk({ title: "Weird", kind: "other", rawInput: {}, rawOutput: [] }),
   // Harness git tools
   mk({
      title: "git_commit",
      harnessTool: "git_commit",
      rawInput: { message: "feat: add x\n\nbody" },
      rawOutput: "Committed abc1234567 on main",
      commitMessage: "feat: add x\n\nbody",
   }),
   mk({
      title: "git_commit",
      harnessTool: "git_commit",
      status: "failed",
      rawOutput: "```\nnothing to commit\n```",
   }),
   mk({ title: "git_push", harnessTool: "git_push", rawOutput: "Pushed feat/x." }),
   mk({
      title: "git_status",
      harnessTool: "git_status",
      rawOutput: "On branch main\n3 files changed",
   }),
   mk({
      title: "git_diff",
      harnessTool: "git_diff",
      rawInput: { from: "a", to: "b" },
      rawOutput: "+x\n-y",
   }),
   mk({ title: "list_branches", harnessTool: "list_branches", rawOutput: "* main\n  dev" }),
   mk({ title: "git_push", harnessTool: "git_push", approval: "denied", status: "pending" }),
   mk({ title: "other_tool", harnessTool: "other_tool", rawInput: { a: 1 } }),
   // Harness Sub Session tools
   mk({
      title: "session_start",
      harnessTool: "session_start",
      rawInput: { title: "Fix", folder: "/w/repo", prompt: "Do it", model: "m1", effort: "high" },
      rawOutput: JSON.stringify({ session_id: "s1", title: "Fix" }),
   }),
   mk({ title: "session_send", harnessTool: "session_send", rawInput: { id: "s1", text: "more" } }),
   mk({
      title: "session_wait",
      harnessTool: "session_wait",
      rawInput: { id: "s1" },
      rawOutput: JSON.stringify({
         title: "Fix",
         reply: "Done.",
         duration_ms: 65000,
         status: "idle",
      }),
   }),
   mk({
      title: "session_wait",
      harnessTool: "session_wait",
      rawInput: { id: "s1", timeout_s: 0 },
      rawOutput: JSON.stringify({ title: "Fix", status: "working" }),
   }),
   mk({
      title: "session_list",
      harnessTool: "session_list",
      rawOutput: JSON.stringify({
         sub_sessions: [
            { session_id: "s1", title: "Fix", repo: "repo", status: "working" },
            { session_id: "s2", title: "Old", status: "idle", archived: true },
         ],
      }),
   }),
   mk({
      title: "session_list",
      harnessTool: "session_list",
      rawOutput: JSON.stringify({ sub_sessions: [] }),
   }),
   mk({
      title: "session_send",
      harnessTool: "session_send",
      status: "failed",
      rawInput: { id: "s1", text: "x" },
      rawOutput: "```\nsession not found\n```",
   }),
   // Tool search
   mk({
      title: "ToolSearch",
      rawInput: { query: "select:Read,Edit" },
      rawOutput: [
         { type: "tool_reference", tool_name: "mcp__a__b" },
         { type: "tool_reference", tool_name: "Read" },
      ],
   }),
   mk({
      title: "ToolSearch",
      rawInput: { query: "slack send" },
      content: text("Tool: mcp__s__send"),
   }),
   mk({ title: "ToolSearch", rawInput: { query: "nothing" }, rawOutput: [] }),
   mk({ title: "ToolSearch", status: "in_progress", rawInput: { query: "x" } }),
];

// A subagent with nested steps (a tool call, a thought, its text, a nested subagent), a running
// one, and a background one that has not reported.
const task = mk({
   id: "task1",
   title: "Explore the repo",
   subagentPrompt: "Find the thing",
   subagentMeta: { type: "Explore", model: "m1", modelInherited: true, effort: "low" },
});
const child = (id: string, over: Partial<Tool>) => mk({ id, parent: "task1", ...over });
const nestedTask = child("task2", { title: "Inner", subagentPrompt: "Inner task" });
const items = [
   task,
   child("c1", { title: "Read a.ts", kind: "read", content: text("```ts\nconst a = 1;\n```") }),
   { type: "thought" as const, id: "t1", text: "thinking", ts: 1, parent: "task1" },
   { type: "agent" as const, id: "a1", text: "interim text", ts: 1, parent: "task1" },
   nestedTask,
   mk({
      id: "n1",
      parent: "task2",
      title: "Terminal",
      kind: "execute",
      rawInput: { command: "pwd" },
   }),
   child("rep", { report: "Final report", title: "report" }),
   mk({ id: "task3", title: "Running one", status: "in_progress", subagentPrompt: "p" }),
   mk({ id: "k1", parent: "task3", title: "Read b.ts", kind: "read", status: "in_progress" }),
   mk({ id: "task4", title: "Failed one", status: "failed", subagentPrompt: "p" }),
   mk({ id: "k2", parent: "task4", title: "Read c.ts", kind: "read" }),
   mk({ id: "task5", title: "Background job", background: true, subagentPrompt: "bg" }),
   mk({ id: "k3", parent: "task5", title: "Read d.ts", kind: "read" }),
];
const grouped = groupSubagents(
   items,
   (i) => (i.type === "tool" ? i : null),
   (i) => (i.type === "thought" || i.type === "agent" ? i.parent : null),
);
const subagents = grouped.subagents as Map<string, ChatSubagent>;
const rootSteps: Step[] = [
   ...variants,
   ...grouped.rows.filter((i): i is Tool => i.type === "tool"),
   { type: "thought", id: "t0", text: "root thought", ts: 1, parent: null },
];
const allIds = [
   ...rootSteps.map((s) => s.id),
   ...[...subagents.values()].flatMap((s) => s.steps.map((i) => (i as { id: string }).id)),
];

afterEach(cleanup);

// happy-dom has no canvas; the diff viewer measures text with one.
HTMLCanvasElement.prototype.getContext = (() => ({
   font: "",
   measureText: (t: string) => ({ width: t.length * 7 }),
})) as never;

// Structure and text only: no class, style or data-slot (a restyle must not touch the snapshot; running, error and pending show as data-status, open/closed as data-state). React ids depend on render order: dropped. Icons keep their lucide name, not their path data; one tag per line so a diff reads.
const html = (ui: React.ReactNode) =>
   render(<TooltipProvider>{ui}</TooltipProvider>)
      .container.innerHTML.replace(
         /<svg[^>]*class="[^"]*?(lucide-[\w-]+)[^"]*"[^>]*>.*?<\/svg>/g,
         "<svg $1/>",
      )
      .replace(/_r_\w+_/g, "_r_")
      .replace(/diff-root-diff-[-\d]+/g, "diff-root")
      .replace(/ (class|style|data-slot)="[^"]*"/g, "")
      .replace(/></g, ">\n<");
const trace = (over: { active?: boolean; waiting?: boolean }) => (
   <WaitingForUser.Provider value={over.waiting ?? false}>
      <TraceDisplay steps={rootSteps} subagents={subagents} active={over.active ?? false} />
   </WaitingForUser.Provider>
);

describe("Trace display (recorded before the step view model)", () => {
   it("has the golden tools", () => {
      expect(golden.length).toBeGreaterThanOrEqual(8);
   });
   it("idle, steps closed", () => {
      expect(html(trace({}))).toMatchSnapshot();
   });
   it("turn active, steps closed", () => {
      expect(html(trace({ active: true }))).toMatchSnapshot();
   });
   it("turn active but waiting for the user", () => {
      expect(html(trace({ active: true, waiting: true }))).toMatchSnapshot();
   });
   it("every step open (bodies)", () => {
      const ui = (
         <OpenStep.Provider value={{ path: allIds, nonce: 1 }}>
            {trace({ active: true })}
         </OpenStep.Provider>
      );
      expect(html(ui)).toMatchSnapshot();
   });
});
