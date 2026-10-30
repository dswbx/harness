import type { Item } from "../reducer";

export type Tool = Extract<Item, { type: "tool" }>;

/** Consecutive tool calls, shown together. Keyed by its first call, so the key holds while it grows. */
export type ToolGroup = { type: "tools"; id: string; calls: Tool[] };

/** Folds each run of consecutive tool calls into one group; other items pass through. */
export function groupTools(items: Item[]): (Item | ToolGroup)[] {
  const out: (Item | ToolGroup)[] = [];
  for (const i of items) {
    if (i.type !== "tool") {
      out.push(i);
      continue;
    }
    const last = out.at(-1);
    if (last?.type === "tools") last.calls.push(i);
    else out.push({ type: "tools", id: i.id, calls: [i] });
  }
  return out;
}
