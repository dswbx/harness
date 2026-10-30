import { describe, expect, it } from "vitest";
import type { Event, EventKind } from "@harness/api";
import { initialState, reduce } from "./reducer";
import { groupSubagents, subagentState } from "./subagents";

let seq = 0;
const ev = (kind: EventKind): Event => ({ v: 1, seq: seq++, session_id: "s", thread_id: "main", ts_ms: 0, kind });
const call = (id: string, title: string, parent?: string, report?: string): Event =>
  ev({ type: "ToolCall", tool_call_id: id, title, kind: null, status: null, content: [], locations: [], raw_input: {}, parent_tool_call_id: parent ?? null, report: report ?? null });
const done = (id: string, background = false): Event =>
  ev({ type: "ToolCallUpdate", tool_call_id: id, title: null, kind: null, status: "completed", content: [], locations: null, raw_input: null, raw_output: null, background });
const fold = (events: Event[]) => groupSubagents(events.reduce(reduce, initialState()).items);

describe("subagents", () => {
  it("moves a background subagent's calls under its Task call; its report ends it", () => {
    const events = [
      call("task", "Research S3"),
      done("task", true),
      ev({ type: "AgentMessageChunk", text: "Research agent is running." }),
      call("s1", "WebSearch", "task"),
      done("s1"),
    ];
    const before = fold(events);
    const t = before.rows[0]!;
    expect(t.type === "tool" && subagentState(t, before.subagents.get("task")!)).toBe("running");

    const after = fold([...events, call("hb", "SubagentHandback", "task", "Short answer: No."), done("hb"), ev({ type: "AgentMessageChunk", text: "No." })]);
    expect(after.rows.map((r) => r.type)).toEqual(["tool", "agent", "agent"]);
    const s = after.subagents.get("task")!;
    expect([s.calls.map((c) => c.title), s.report]).toEqual([["WebSearch"], "Short answer: No."]);
    const t2 = after.rows[0]!;
    expect(t2.type === "tool" && subagentState(t2, s)).toBe("done");
  });

  it("a foreground subagent is done when its Task call ends; updates keep the parent", () => {
    const events = [call("task", "T"), call("s1", "Read", "task"), done("s1")];
    const running = fold(events);
    expect(running.rows).toHaveLength(1);
    const t = running.rows[0]!;
    expect(t.type === "tool" && subagentState(t, running.subagents.get("task")!)).toBe("running");
    const finished = fold([...events, done("task")]);
    const t2 = finished.rows[0]!;
    expect(t2.type === "tool" && subagentState(t2, finished.subagents.get("task")!)).toBe("done");
  });

  it("leaves calls in place when their parent is unknown", () => {
    const { rows, subagents } = fold([call("x", "Read", "gone")]);
    expect(rows).toHaveLength(1);
    expect(subagents.size).toBe(0);
  });
});
