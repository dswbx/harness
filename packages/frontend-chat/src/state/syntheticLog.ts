import type { Event, EventKind } from "@harness/api";

/** Synthetic log: ~20k events of mixed turns, chunks, tool calls/updates, task lists, permissions. */
export function syntheticLog(total = 20_000): Event[] {
   const out: Event[] = [];
   const push = (kind: EventKind) =>
      out.push({ v: 1, seq: out.length, session_id: "s", thread_id: "main", ts_ms: 0, kind });
   push({ type: "ThreadStarted", agent_id: "a", main: true });
   let turn = 0;
   let tool = 0;
   while (out.length < total) {
      const t = `t${turn++}`;
      push({ type: "TurnStarted", turn_id: t, text: `prompt ${turn}` });
      for (let i = 0; i < 4; i++) push({ type: "AgentThoughtChunk", text: "thinking " });
      for (let c = 0; c < 3; c++) {
         for (let i = 0; i < 6; i++) push({ type: "AgentMessageChunk", text: `word${i} ` });
         const id = `tc${tool++}`;
         push({
            type: "ToolCall",
            tool_call_id: id,
            title: "Run",
            kind: "execute",
            status: "pending",
            content: [],
            locations: null,
            raw_input: { cmd: "ls" },
         });
         push({
            type: "ToolCallUpdate",
            tool_call_id: id,
            title: null,
            kind: null,
            status: "in_progress",
            content: null,
            locations: null,
            raw_input: null,
            raw_output: null,
         });
         push({
            type: "ToolCallUpdate",
            tool_call_id: id,
            title: null,
            kind: null,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "ok" } }],
            locations: null,
            raw_input: null,
            raw_output: "ok",
         });
      }
      push({
         type: "TaskListUpdated",
         entries: [
            { content: "a", status: "completed", priority: "medium" },
            { content: "b", status: "pending", priority: "medium" },
         ] as never,
      });
      const rid = `r${turn}`;
      push({
         type: "PermissionRequested",
         request_id: rid,
         tool_call: { title: "x" },
         options: [],
      });
      push({ type: "PermissionResolved", request_id: rid, option_id: null, by: "user" as never });
      push({ type: "TurnEnded", turn_id: t, stop_reason: "end_turn" });
   }
   return out.slice(0, total);
}
