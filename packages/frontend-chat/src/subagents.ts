import { blockText, type Item } from "./reducer";

type Tool = Extract<Item, { type: "tool" }>;

/** What a subagent did: its tool calls, and the report it handed back (when it has). */
export type Subagent = { calls: Tool[]; report: string | null };

/** The tool a background subagent calls to send its final report to the main Agent. */
const HANDBACK = "SubagentHandback";

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
    if (i.title === HANDBACK) s.report = handbackText(i);
    else s.calls.push(i);
  }
  return { rows, subagents };
}

export function handbackText(t: Tool): string | null {
  const m = (t.rawInput as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : null;
}

export const isHandback = (t: Tool) => t.title === HANDBACK;

/** A Task call that started a background subagent finishes at once; the subagent goes on. */
const launchedAsync = (t: Tool) => t.content.some((b) => blockText(b)?.startsWith("Async agent launched"));

export type SubagentState = "running" | "done" | "failed";

export function subagentState(task: Tool, s: Subagent): SubagentState {
  if (task.status === "failed") return "failed";
  if (s.report != null) return "done";
  return task.status === "completed" && !launchedAsync(task) ? "done" : "running";
}
