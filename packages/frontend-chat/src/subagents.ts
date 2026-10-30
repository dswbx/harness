import type { Item } from "./reducer";

type Tool = Extract<Item, { type: "tool" }>;

/** The tool calls a subagent made. */
export type Subagent = { calls: Tool[] };

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
    if (!s) subagents.set(i.parent, (s = { calls: [] }));
    s.calls.push(i);
  }
  return { rows, subagents };
}

export type SubagentState = "running" | "done" | "failed";

const finished = (t: Tool) => t.status === "completed" || t.status === "failed";

/** From the calls alone (no Agent-specific signals): running while any call is unfinished. */
export function subagentState(task: Tool, s: Subagent): SubagentState {
  if (task.status === "failed") return "failed";
  return s.calls.every(finished) ? "done" : "running";
}
