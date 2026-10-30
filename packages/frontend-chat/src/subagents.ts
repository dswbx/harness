import type { Item } from "./reducer";

type Tool = Extract<Item, { type: "tool" }>;

/** What a subagent did: its tool calls, and the report it handed back (when it has). */
export type Subagent = { calls: Tool[]; report: string | null };

/**
 * Moves tool calls made by a subagent under its Task call. Calls whose Task call is not in the
 * list stay where they are (e.g. logs from before parent ids were recorded).
 */
export function groupSubagents(items: Item[]): { rows: Item[]; subagents: Map<string, Subagent> } {
  const tools = new Set(items.flatMap((i) => (i.type === "tool" ? [i.id] : [])));
  const subagents = new Map<string, Subagent>();
  const rows: Item[] = [];
  for (const i of items) {
    if (i.type !== "tool" || !i.parent || !tools.has(i.parent)) {
      rows.push(i);
      continue;
    }
    let s = subagents.get(i.parent);
    if (!s) subagents.set(i.parent, (s = { calls: [], report: null }));
    if (i.report != null) s.report = i.report;
    else s.calls.push(i);
  }
  return { rows, subagents };
}

export type SubagentState = "running" | "done" | "failed";

/** A background subagent is done when its report arrives; any other when its Task call ends. */
export function subagentState(task: Tool, s: Subagent): SubagentState {
  if (task.status === "failed") return "failed";
  if (s.report != null) return "done";
  return task.status === "completed" && !task.background ? "done" : "running";
}
