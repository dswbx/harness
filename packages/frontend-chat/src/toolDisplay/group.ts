import type { Item } from "../reducer";

export type Tool = Extract<Item, { type: "tool" }>;
export type Thought = Extract<Item, { type: "thought" }>;
/** One line of a run: a tool call, or a thought between them. */
export type Step = Tool | Thought;

/** Consecutive tool calls and thoughts, shown together. Keyed by its first step, so the key holds while it grows. */
export type ToolGroup = { type: "tools"; id: string; steps: Step[] };

/** Folds each run of consecutive tool calls and thoughts into one group; other items pass through. */
export function groupTools(items: Item[]): (Item | ToolGroup)[] {
   const out: (Item | ToolGroup)[] = [];
   for (const i of items) {
      if (i.type !== "tool" && i.type !== "thought") {
         out.push(i);
         continue;
      }
      const last = out.at(-1);
      if (last?.type === "tools") last.steps.push(i);
      else out.push({ type: "tools", id: i.id, steps: [i] });
   }
   return out;
}
