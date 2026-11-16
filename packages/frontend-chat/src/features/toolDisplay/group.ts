import type { Subagent } from "@harness/api";
import type { Item } from "../../state/reducer";

export type Tool = Extract<Item, { type: "tool" }>;
/** A subagent as the chat keeps it: its steps are chat items (tool calls, thoughts, text). */
export type ChatSubagent = Subagent<Tool, Item>;
export type Thought = Extract<Item, { type: "thought" }>;
/** One line of a run: a tool call, or a thought between them. */
export type Step = Tool | Thought;

/**
 * A pending request to run a tool call, answered in the chat (not a plan, not the policy's answer).
 * With `step` (set by `chatRows`) it stands in for that step until answered.
 */
export type Approval = Extract<Item, { type: "permission" }>;

const isApproval = (i: Item): i is Approval =>
   i.type === "permission" && !i.resolved && !i.auto && !i.plan;

/**
 * Consecutive tool calls and thoughts, shown together, with the pending approvals among them (shown
 * last, so the run is not split while the user answers). Keyed by its first entry, so the key holds while it grows.
 */
export type ToolGroup = { type: "tools"; id: string; steps: Step[]; approvals: Approval[] };

/** Folds each run of consecutive tool calls, thoughts and pending step approvals into one group; other items pass through. */
export function groupTools(items: Item[]): (Item | ToolGroup)[] {
   const out: (Item | ToolGroup)[] = [];
   for (const i of items) {
      const approval = isApproval(i);
      if (!approval && i.type !== "tool" && i.type !== "thought") {
         out.push(i);
         continue;
      }
      let last = out.at(-1);
      if (last?.type !== "tools") {
         last = { type: "tools", id: i.id, steps: [], approvals: [] };
         out.push(last);
      }
      if (approval) last.approvals.push(i);
      else last.steps.push(i as Step);
   }
   return out;
}

/** Where a step shows in the chat: its row's key, and the steps to open from the row's down to it (its own last). */
export type StepPlace = { row: string; path: string[] };

/**
 * Finds every tool call and thought in `rows` (from `groupTools`), and those of subagents inside them
 * (nested ones too): the row it shows in and its path. Rows are virtual, so a jump needs the row first.
 */
export function placeSteps(
   rows: (Item | ToolGroup)[],
   subagents: Map<string, ChatSubagent>,
): Map<string, StepPlace> {
   const out = new Map<string, StepPlace>();
   const visit = (row: string, steps: Item[], path: string[]) => {
      for (const s of steps) {
         if (s.type !== "tool" && s.type !== "thought") continue;
         if (out.has(s.id)) continue;
         const p = [...path, s.id];
         out.set(s.id, { row, path: p });
         const sub = s.type === "tool" ? subagents.get(s.id) : undefined;
         if (sub) visit(row, sub.steps, p);
      }
   };
   for (const r of rows) visit(r.id, r.type === "tools" ? r.steps : [r], []);
   return out;
}

/** The subagents a row shows (its tool calls' own, and those nested inside them), in step order. */
export function subagentsOf(
   row: Item | ToolGroup,
   subagents: Map<string, ChatSubagent>,
): ChatSubagent[] {
   const out: ChatSubagent[] = [];
   const visit = (steps: readonly Item[]) => {
      for (const s of steps) {
         const sub = s.type === "tool" ? subagents.get(s.id) : undefined;
         if (!sub) continue;
         out.push(sub);
         visit(sub.steps);
      }
   };
   visit(row.type === "tools" ? row.steps : [row]);
   return out;
}
