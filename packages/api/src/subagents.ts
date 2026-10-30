/**
 * Subagents from tool call Events (ADR 0012, shared helper): which calls a subagent made, its
 * report, and whether it is still working. Built on the generic fields the core fills in
 * (`parent_tool_call_id`, `background`, `report`), so it works for any Agent that sends them.
 */

/** The fields of a tool call (as a Frontend keeps it) that subagents need. */
export type SubagentTool = { id: string; parent: string | null; status: string | null; background: boolean; report: string | null };

/** What a subagent did: its tool calls, and the report it handed back (when it has). */
export type Subagent<T extends SubagentTool = SubagentTool> = { calls: T[]; report: string | null };

/**
 * Moves tool calls made by a subagent under the call that started it. `asTool` picks the tool
 * calls out of a Frontend's items. Calls whose parent is not in the list stay where they are
 * (e.g. logs from before parent ids were recorded).
 */
export function groupSubagents<I, T extends SubagentTool>(
  items: I[],
  asTool: (i: I) => T | null,
): { rows: I[]; subagents: Map<string, Subagent<T>> } {
  const ids = new Set(items.flatMap((i) => asTool(i)?.id ?? []));
  const subagents = new Map<string, Subagent<T>>();
  const rows: I[] = [];
  for (const i of items) {
    const t = asTool(i);
    if (!t?.parent || !ids.has(t.parent)) {
      rows.push(i);
      continue;
    }
    let s = subagents.get(t.parent);
    if (!s) subagents.set(t.parent, (s = { calls: [], report: null }));
    if (t.report != null) s.report = t.report;
    else s.calls.push(t);
  }
  return { rows, subagents };
}

export type SubagentState = "running" | "done" | "failed";

/** A background subagent is done when its report arrives; any other when its starting call ends. */
export function subagentState(task: SubagentTool, s: Subagent): SubagentState {
  if (task.status === "failed") return "failed";
  if (s.report != null) return "done";
  return task.status === "completed" && !task.background ? "done" : "running";
}
