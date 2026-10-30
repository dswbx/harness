import { describe, expect, it } from "vitest";
import type { Event, EventKind } from "@harness/api";
import { initialState, reduce } from "./reducer";
import { groupSubagents, subagentState } from "./subagents";

let seq = 0;
const ev = (kind: EventKind): Event => ({ v: 1, seq: seq++, session_id: "s", thread_id: "main", ts_ms: 0, kind });
const call = (id: string, title: string, parent?: string, raw_input: unknown = {}): Event =>
  ev({ type: "ToolCall", tool_call_id: id, title, kind: null, status: null, content: [], locations: [], raw_input, parent_tool_call_id: parent ?? null });
const done = (id: string, text = "ok"): Event =>
  ev({
    type: "ToolCallUpdate", tool_call_id: id, title: null, kind: null, status: "completed",
    content: [{ type: "content", content: { type: "text", text } }], locations: null, raw_input: null, raw_output: null,
  });
const fold = (events: Event[]) => groupSubagents(events.reduce(reduce, initialState()).items);

describe("subagents", () => {
  it("moves a subagent's calls under its Task call", () => {
    const { rows, subagents } = fold([
      call("task", "Research S3", undefined, { prompt: "Look it up" }),
      done("task", "Async agent launched successfully."),
      ev({ type: "AgentMessageChunk", text: "Research agent is running." }),
      call("s1", "WebSearch", "task"),
      done("s1"),
      call("hb", "SubagentHandback", "task", { message: "Short answer: No." }),
      done("hb"),
      ev({ type: "AgentMessageChunk", text: "It is not possible." }),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["tool", "agent", "agent"]);
    const s = subagents.get("task")!;
    expect(s.calls.map((c) => c.title)).toEqual(["WebSearch", "SubagentHandback"]);
    const task = rows[0]!;
    expect(task.type === "tool" && subagentState(task, s)).toBe("done");
  });

  it("is running while a call is unfinished; an update keeps the parent", () => {
    const events = [call("task", "T"), done("task"), call("s1", "Read", "task")];
    const running = fold(events);
    expect(running.rows).toHaveLength(1);
    const t = running.rows[0]!;
    expect(t.type === "tool" && subagentState(t, running.subagents.get("task")!)).toBe("running");
    // Updates often omit the parent; the call keeps it.
    const finished = fold([...events, done("s1")]);
    const t2 = finished.rows[0]!;
    expect(finished.rows).toHaveLength(1);
    expect(t2.type === "tool" && subagentState(t2, finished.subagents.get("task")!)).toBe("done");
  });

  it("leaves calls in place when their parent is unknown", () => {
    const { rows, subagents } = fold([call("x", "Read", "gone")]);
    expect(rows).toHaveLength(1);
    expect(subagents.size).toBe(0);
  });
});
