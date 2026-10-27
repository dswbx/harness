import type { Event, EventKind } from "@harness/api";
import codexLog from "../../../packages/frontend-chat/src/fixtures/codex-basic.jsonl?raw";

/** Recorded Codex log plus a synthetic tail (task list, diff, plan approval) so the whole chat UI is exercisable. */
export function mockEvents(): Event[] {
  const recorded = codexLog.trim().split("\n").map((l) => JSON.parse(l) as Event);
  let seq = recorded.length;
  const t0 = recorded.at(-1)!.ts_ms;
  const thread = recorded.find((e) => e.thread_id)?.thread_id ?? "main";
  const ev = (kind: EventKind): Event => ({ v: 1, seq: seq++, session_id: "mock", thread_id: thread, ts_ms: t0 + seq * 100, kind });
  return [
    ...recorded,
    ev({ type: "TurnStarted", turn_id: "mock-t2", text: "Now rename it and plan a refactor (synthetic)." }),
    ev({ type: "TaskListUpdated", entries: [
      { content: "Rename hello.txt", priority: "medium", status: "completed" },
      { content: "Draft refactor plan", priority: "medium", status: "in_progress" },
      { content: "Implement", priority: "medium", status: "pending" },
    ] }),
    ev({ type: "ToolCall", tool_call_id: "mock-edit", title: "Editing files", kind: "edit", status: "completed",
      content: [{ type: "diff", path: "hello.txt", oldText: "hi\nthere", newText: "hello\nthere\nworld" }], locations: [], raw_input: { path: "hello.txt" } }),
    ev({ type: "ToolCall", tool_call_id: "mock-harness", title: "mcp__harness__git_status", kind: "other", status: "completed", content: [], locations: [], raw_input: {} }),
    ev({ type: "FrontendToolOutput", tool: "json_render", call_id: "mock-card", path: "json_render/mock-card.json",
      input: { title: "Rename done", body: "`hello.txt` is now **hello**.", items: [{ label: "Files", value: "1" }], tone: "success" } }),
    ev({ type: "AgentMessageChunk", text: "Renamed. Here is a **plan** next." }),
    ev({ type: "PermissionRequested", request_id: "mock-push",
      tool_call: { toolCallId: "push:1", kind: "git_push", title: "mcp__harness__git_push", rawInput: {} },
      options: [
        { option_id: "allow", name: "Allow", kind: "allow_once" },
        { option_id: "deny", name: "Deny", kind: "reject_once" },
      ] }),
    ev({ type: "PermissionRequested", request_id: "mock-plan",
      tool_call: { toolCallId: "plan-review:1", kind: "switch_mode", title: "Implement this plan?", rawInput: { plan: "## Refactor\n\n1. Split module\n2. Add tests\n\n```ts\nconst x = 1\n```" } },
      options: [
        { option_id: "implement_plan", name: "Implement this plan", kind: "allow_once" },
        { option_id: "revise_plan", name: "Revise", kind: "reject_once" },
      ] }),
  ];
}
