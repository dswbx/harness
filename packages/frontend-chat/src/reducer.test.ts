import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Event, EventKind } from "@harness/api";
import { harnessToolName, initialState, permissionTitle, planOf, reduce, type ChatState } from "./reducer";
import { diffLines } from "./diff";

const fold = (events: Event[]): ChatState => events.reduce(reduce, initialState());
const load = (name: string): Event[] =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Event);

let seq = 0;
const ev = (kind: EventKind, thread_id: string | null = "main"): Event => ({
  v: 1, seq: seq++, session_id: "s", thread_id, ts_ms: 0, kind,
});
const started = () => ev({ type: "ThreadStarted", agent_id: "a", main: true });

describe("golden: codex-basic (recorded with Codex)", () => {
  const events = load("codex-basic.jsonl");
  const s = fold(events);

  it("coalesces ~token chunks into few agent blocks, split by tool calls", () => {
    const chunks = events.filter((e) => e.kind.type === "AgentMessageChunk").length;
    const agents = s.items.filter((i) => i.type === "agent");
    expect(chunks).toBeGreaterThan(30);
    expect(agents.length).toBe(2);
    expect(agents[1]!.type === "agent" && agents[1]!.text).toContain("Created `hello.txt`");
  });

  it("builds one tool card per tool_call_id, merged with its update", () => {
    const tools = s.items.filter((i) => i.type === "tool");
    expect(tools).toHaveLength(3);
    expect(tools.every((t) => t.type === "tool" && t.status === "completed")).toBe(true);
    expect(tools.some((t) => t.type === "tool" && t.kind === "execute" && t.title.includes("hello.txt"))).toBe(true);
  });

  it("derives turn, user message, config, commands, usage, title", () => {
    expect(s.items[0]).toMatchObject({ type: "user" });
    expect(s.turnId).toBeNull();
    expect(s.configOptions.map((o) => o.id)).toContain("mode");
    expect(s.configOptions.find((o) => o.id === "model")?.options.length).toBeGreaterThan(1);
    expect(s.commands.length).toBeGreaterThan(0);
    expect(s.usage?.size).toBe(475000);
    expect(s.title).toMatch(/hello\.txt/);
    expect(s.process?.state).toBe("ready");
  });

  it("is replay-deterministic: any prefix folded in two steps equals one pass", () => {
    const cut = 30;
    const stepped = events.slice(cut).reduce(reduce, fold(events.slice(0, cut)));
    expect(stepped).toEqual(s);
  });
});

describe("turns", () => {
  it("tracks a running turn and shows non-end_turn stop reasons", () => {
    let s = fold([started(), ev({ type: "TurnStarted", turn_id: "t1", text: "hi" })]);
    expect(s.turnId).toBe("t1");
    s = reduce(s, ev({ type: "TurnEnded", turn_id: "t1", stop_reason: "cancelled" }));
    expect(s.turnId).toBeNull();
    expect(s.items.at(-1)).toMatchObject({ type: "notice", text: "Turn stopped: cancelled" });
  });

  it("end_turn adds no notice; thought and message chunks stay separate blocks", () => {
    const s = fold([
      started(),
      ev({ type: "TurnStarted", turn_id: "t1", text: "q" }),
      ev({ type: "AgentThoughtChunk", text: "hm" }),
      ev({ type: "AgentThoughtChunk", text: "m" }),
      ev({ type: "AgentMessageChunk", text: "a" }),
      ev({ type: "AgentMessageChunk", text: "b" }),
      ev({ type: "TurnEnded", turn_id: "t1", stop_reason: "end_turn" }),
    ]);
    expect(s.items.map((i) => i.type)).toEqual(["user", "thought", "agent"]);
    expect(s.items[1]).toMatchObject({ text: "hmm" });
    expect(s.items[2]).toMatchObject({ text: "ab" });
  });

  it("messages keep the time of their first Event", () => {
    const at = (ts_ms: number, kind: EventKind) => ({ ...ev(kind), ts_ms });
    const s = fold([
      started(),
      at(100, { type: "TurnStarted", turn_id: "t1", text: "q" }),
      at(200, { type: "AgentMessageChunk", text: "a" }),
      at(300, { type: "AgentMessageChunk", text: "b" }),
    ]);
    expect(s.items.map((i) => i.type !== "tool" && "ts" in i && i.ts)).toEqual([100, 200]);
  });

  it("shows boundaries (not initial) and errors", () => {
    const s = fold([
      ev({ type: "AgentSessionStarted", acp_session_id: "x", boundary: "initial" }),
      ev({ type: "AgentSessionStarted", acp_session_id: "y", boundary: "agent_switched" }),
      ev({ type: "Error", message: "boom" }),
    ]);
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ level: "boundary", text: "Switched to a different Agent in a new session" });
    expect(s.items[1]).toMatchObject({ level: "error", text: "boom" });
  });

  it("ignores Side Thread events", () => {
    const s = fold([
      started(),
      ev({ type: "AgentMessageChunk", text: "side" }, "other"),
      ev({ type: "AgentMessageChunk", text: "main" }),
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ text: "main" });
  });

  it("ignores events of a Side Thread started later, keeps session-level events", () => {
    const s = fold([
      started(),
      ev({ type: "ThreadStarted", agent_id: "a", main: false }, "side"),
      ev({ type: "ThreadReadOnly", reason: "x" }, "side"),
      ev({ type: "TurnStarted", turn_id: "t", text: "hi" }, "side"),
      ev({ type: "SessionInfoUpdated", title: "T" }, null),
    ]);
    expect(s.mainThreadId).toBe("main");
    expect(s.readOnly).toBe(false);
    expect(s.turnId).toBeNull();
    expect(s.title).toBe("T");
  });
});

describe("continuity", () => {
  it("read-only is set by ThreadReadOnly and cleared by continued_with_summary", () => {
    let s = fold([started(), ev({ type: "ThreadReadOnly", reason: "gone" })]);
    expect(s.readOnly).toBe(true);
    s = [ev({ type: "AgentSessionStarted", acp_session_id: "n", boundary: "resumed" })].reduce(reduce, s);
    expect(s.readOnly).toBe(true);
    s = [ev({ type: "AgentSessionStarted", acp_session_id: "n", boundary: "continued_with_summary" })].reduce(reduce, s);
    expect(s.readOnly).toBe(false);
    expect(s.items.at(-1)).toMatchObject({ level: "boundary", text: "Continued in a new Agent session with a summary" });
  });

  it("friendly boundary text for resumed and loaded", () => {
    const s = fold([
      ev({ type: "AgentSessionStarted", acp_session_id: "a", boundary: "resumed" }),
      ev({ type: "AgentSessionStarted", acp_session_id: "b", boundary: "loaded" }),
    ]);
    expect(s.items.map((i) => i.type === "notice" && i.text)).toEqual(["Agent session resumed", "Agent session reloaded"]);
  });

  it("stopped shows an info notice", () => {
    const s = fold([ev({ type: "AgentProcessState", state: "stopped", message: "idle" })]);
    expect(s.process?.state).toBe("stopped");
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ level: "info", text: expect.stringContaining("Agent stopped while idle") });
  });

  it("crash mid-turn shows an error notice", () => {
    const s = fold([
      started(),
      ev({ type: "TurnStarted", turn_id: "t", text: "go" }),
      ev({ type: "Error", message: "agent died" }),
      ev({ type: "TurnEnded", turn_id: "t", stop_reason: "error" }),
      ev({ type: "AgentProcessState", state: "exited", message: null }),
    ]);
    expect(s.items.at(-1)).toMatchObject({ level: "error", text: "Agent process ended unexpectedly" });
  });

  it("exit with nothing running shows no notice", () => {
    const s = fold([
      started(),
      ev({ type: "TurnStarted", turn_id: "t", text: "go" }),
      ev({ type: "TurnEnded", turn_id: "t", stop_reason: "end_turn" }),
      ev({ type: "AgentProcessState", state: "exited", message: null }),
    ]);
    expect(s.items.filter((i) => i.type === "notice")).toHaveLength(0);
  });
});

describe("tool calls (synthetic)", () => {
  it("merges updates: status, content replaced, title kept", () => {
    const s = fold([
      ev({ type: "ToolCall", tool_call_id: "c1", title: "Editing files", kind: "edit", status: "pending", content: [], locations: [], raw_input: { a: 1 } }),
      ev({
        type: "ToolCallUpdate", tool_call_id: "c1", title: null, kind: null, status: "completed",
        content: [{ type: "diff", path: "a.txt", oldText: "x", newText: "y" }], locations: null, raw_input: null, raw_output: "ok",
      }),
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ title: "Editing files", status: "completed", rawInput: { a: 1 }, rawOutput: "ok" });
    expect((s.items[0] as { content: unknown[] }).content).toHaveLength(1);
  });

  it("takes the full input from a later update (call streamed with {})", () => {
    const s = fold([
      ev({ type: "ToolCall", tool_call_id: "c2", title: "Bash", kind: "execute", status: "pending", content: [], locations: [], raw_input: {} }),
      ev({ type: "ToolCallUpdate", tool_call_id: "c2", title: null, kind: null, status: null, content: null, locations: null, raw_input: { command: "ls" }, raw_output: null }),
    ]);
    expect(s.items[0]).toMatchObject({ rawInput: { command: "ls" } });
  });

  it("splits agent text around a notice", () => {
    const s = fold([
      ev({ type: "AgentMessageChunk", text: "a" }),
      ev({ type: "AgentNotice", severity: "info", title: "UserPromptSubmit says", description: "hi" }),
      ev({ type: "AgentMessageChunk", text: "b" }),
    ]);
    expect(s.items.map((i) => i.type)).toEqual(["agent", "agent_notice", "agent"]);
  });

  it("creates a card for an update with no preceding call", () => {
    const s = fold([ev({ type: "ToolCallUpdate", tool_call_id: "z", title: "T", kind: null, status: "failed", content: null, locations: null, raw_input: null, raw_output: null })]);
    expect(s.items[0]).toMatchObject({ type: "tool", title: "T", status: "failed" });
  });
});

describe("task list, config, usage (synthetic)", () => {
  it("keeps the latest Task List", () => {
    const s = fold([
      ev({ type: "TaskListUpdated", entries: [{ content: "a", priority: "medium", status: "pending" }] }),
      ev({ type: "TaskListUpdated", entries: [{ content: "a", priority: "medium", status: "completed" }, { content: "b", priority: "medium", status: "in_progress" }] }),
    ]);
    expect(s.taskList.map((t) => t.status)).toEqual(["completed", "in_progress"]);
  });
});

describe("permissions (synthetic, shape from codex plan spike)", () => {
  const plan = ev({
    type: "PermissionRequested",
    request_id: "r1",
    tool_call: { toolCallId: "plan-review:1", kind: "switch_mode", title: "Implement this plan?", rawInput: { plan: "# Plan\n- step" } },
    options: [
      { option_id: "implement_plan", name: "Implement", kind: "allow_once" },
      { option_id: "revise_plan", name: "Revise", kind: "reject_once" },
    ],
  });

  it("surfaces a plan approval and hides it once resolved", () => {
    let s = fold([plan]);
    const p = s.items[0]!;
    expect(p.type === "permission" && planOf(p.toolCall)).toBe("# Plan\n- step");
    expect(p).toMatchObject({ resolved: false });
    s = reduce(s, ev({ type: "PermissionResolved", request_id: "r1", option_id: "implement_plan", by: "view" }));
    expect(s.items[0]).toMatchObject({ resolved: true });
  });

  it("planOf is null for ordinary permission requests", () => {
    expect(planOf({ kind: "execute", rawInput: { plan: "x" } })).toBeNull();
    expect(planOf({ kind: "switch_mode", rawInput: {} })).toBeNull();
  });
});

describe("permission policy", () => {
  const req = () =>
    ev({
      type: "PermissionRequested",
      request_id: "r2",
      tool_call: { toolCallId: "t", kind: "execute", title: "echo hi" },
      options: [
        { option_id: "a", name: "Allow", kind: "allow_once" },
        { option_id: "d", name: "Reject", kind: "reject_once" },
      ],
    });

  it("policy resolution marks auto allow/deny, with rule or default", () => {
    let s = fold([req()]);
    s = reduce(s, ev({ type: "PermissionResolved", request_id: "r2", option_id: "a", by: "policy", rule_id: "rule-1" }));
    expect(s.items[0]).toMatchObject({ resolved: true, auto: { allowed: true, ruleId: "rule-1" } });
    s = reduce(fold([req()]), ev({ type: "PermissionResolved", request_id: "r2", option_id: "d", by: "policy", rule_id: null }));
    expect(s.items[0]).toMatchObject({ resolved: true, auto: { allowed: false, ruleId: null } });
  });

  it("view resolution has no auto note", () => {
    const s = reduce(fold([req()]), ev({ type: "PermissionResolved", request_id: "r2", option_id: "a", by: "view" }));
    expect(s.items[0]).toMatchObject({ resolved: true });
    expect((s.items[0] as { auto?: unknown }).auto).toBeUndefined();
  });

  it("PermissionRuleAdded renders a system note", () => {
    const rule = (tool_kind: string | null, pattern: string | null) => ({
      type: "PermissionRuleAdded" as const,
      rule: { id: "x", scope: { type: "session" as const, session_id: "s" }, tool_kind, pattern, decision: "allow" as const },
    });
    let s = reduce(initialState(), ev(rule("execute", "echo hi")));
    s = reduce(s, ev(rule("edit", null)));
    expect(s.items.map((i) => i.type === "notice" && i.text)).toEqual([
      "Remembered for this session: allow `echo hi`",
      "Remembered for this session: allow all edit",
    ]);
  });
});

describe("diffLines", () => {
  it("produces unified-style lines", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { op: " ", text: "a" }, { op: "-", text: "b" }, { op: "+", text: "B" }, { op: " ", text: "c" },
    ]);
  });
  it("treats missing old text as a new file", () => {
    expect(diffLines(null, "x\ny")).toEqual([{ op: "+", text: "x" }, { op: "+", text: "y" }]);
  });
});

describe("git and workspace events", () => {
  const files = [{ path: "a.ts", status: "M", additions: 2, deletions: 1 }];

  it("WorkspaceChanged becomes a changes row carrying the turn's trees", () => {
    const s = fold([started(), ev({ type: "WorkspaceChanged", turn_id: "t1", from_tree: "A", to_tree: "B", files })]);
    expect(s.items[0]).toMatchObject({ type: "changes", turnId: "t1", fromTree: "A", toTree: "B", files });
  });

  it("WorkspaceChanged with no files renders nothing", () => {
    const s = fold([started(), ev({ type: "WorkspaceChanged", turn_id: "t1", from_tree: "A", to_tree: "A", files: [] })]);
    expect(s.items).toHaveLength(0);
  });

  it("GitCommitted and GitPushed become notices", () => {
    const s = fold([
      started(),
      ev({ type: "GitCommitted", commit: "abcdef1234", message: "fix it" }),
      ev({ type: "GitPushed", branch: "harness/x-1" }),
    ]);
    expect(s.items[0]).toMatchObject({ type: "notice", text: "Committed abcdef1: fix it" });
    expect(s.items[1]).toMatchObject({ type: "notice", text: "Pushed harness/x-1" });
  });

  it("SessionArchived toggles archived and adds a notice", () => {
    const a = fold([started(), ev({ type: "SessionArchived", archived: true })]);
    expect(a.archived).toBe(true);
    expect(a.items[0]).toMatchObject({ type: "notice", text: "Session archived" });
    const b = [ev({ type: "SessionArchived", archived: false })].reduce(reduce, a);
    expect(b.archived).toBe(false);
  });

  it("stopped with archived/deleted message adds no idle notice", () => {
    const s = fold([ev({ type: "AgentProcessState", state: "stopped", message: "archived" })]);
    expect(s.process?.state).toBe("stopped");
    expect(s.items).toHaveLength(0);
  });
});

describe("AuthRequired", () => {
  it("adds an auth item with the methods", () => {
    const methods = [{ id: "m", name: "Login", description: null, kind: "terminal" }];
    const s = fold([started(), ev({ type: "AuthRequired", methods, message: "sign in" })]);
    const item = s.items[s.items.length - 1];
    expect(item).toMatchObject({ type: "auth", message: "sign in", methods });
  });
});

describe("Frontend Tools", () => {
  const out = (tool: string, input: unknown) =>
    fold([started(), ev({ type: "FrontendToolOutput", tool, call_id: "c1", path: `${tool}/c1.json`, input })]).items[0]!;

  it("validates json_render input", () => {
    const it = out("json_render", { title: "Done", items: [{ label: "a", value: "b" }], tone: "success" });
    expect(it).toMatchObject({ type: "frontend_tool", tool: "json_render", render: { ok: true } });
  });
  it("flags invalid json_render input and keeps raw input", () => {
    const it = out("json_render", { body: "no title", tone: "loud" });
    expect(it).toMatchObject({ type: "frontend_tool", render: { ok: false }, input: { tone: "loud" } });
    expect(it.type === "frontend_tool" && it.render && !it.render.ok && it.render.errors.length).toBeGreaterThan(0);
  });
  it("leaves unknown tools unrendered", () => {
    expect(out("mystery", { x: 1 })).toMatchObject({ type: "frontend_tool", tool: "mystery", render: null });
  });
});

describe("Harness tool helpers", () => {
  it("detects Claude and Codex titles", () => {
    expect(harnessToolName("mcp__harness__git_status")).toBe("git_status");
    expect(harnessToolName("mcp.harness.git_status")).toBe("git_status");
    expect(harnessToolName("mcp__other__x")).toBeNull();
    expect(harnessToolName("Run ls")).toBeNull();
  });
  it("titles Harness permission requests", () => {
    expect(permissionTitle({ kind: "git_push" })).toBe("Push branch to origin?");
    expect(permissionTitle({ kind: "git_commit", rawInput: { message: "fix" } })).toBe('Commit all changes: "fix"?');
    expect(permissionTitle({ kind: "frontend_tool", title: "Frontend tool: json_render" })).toBe("Let the Agent use Frontend tool json_render?");
    expect(permissionTitle({ kind: "execute" })).toBeNull();
  });
});
