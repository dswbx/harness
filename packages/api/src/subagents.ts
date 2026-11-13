/**
 * Subagents from tool call Events (ADR 0012, shared helper): which calls a subagent made, its
 * report, and whether it is still working. Built on the generic fields the core fills in
 * (`parent_tool_call_id`, `background`, `report`), so it works for any Agent that sends them.
 */

/** The fields of a tool call (as a Frontend keeps it) that subagents need. */
export type SubagentTool = {
   id: string;
   parent: string | null;
   status: string | null;
   background: boolean;
   report: string | null;
   /** When the call started (ms). */
   ts?: number | null;
   /** When the call completed or failed (ms). */
   endedAt?: number | null;
};

/**
 * What a subagent did: its tool calls, every step in order (its tool calls plus its own thoughts
 * and text, as the Frontend's items), the report it handed back, and when it ended.
 */
export type Subagent<T extends SubagentTool = SubagentTool, I = unknown> = {
   calls: T[];
   steps: I[];
   report: string | null;
   /** When it ended (ms): its report for a background subagent, else its starting call's end. */
   endedAt: number | null;
};

/**
 * Moves tool calls made by a subagent under the call that started it. `asTool` picks the tool
 * calls out of a Frontend's items; `parentOf` names the starting call of any other item (e.g. a
 * subagent's thoughts and text). Items whose parent is not in the list stay where they are
 * (e.g. logs from before parent ids were recorded).
 */
export function groupSubagents<I, T extends SubagentTool>(
   items: I[],
   asTool: (i: I) => T | null,
   parentOf?: (i: I) => string | null,
): { rows: I[]; subagents: Map<string, Subagent<T, I>> } {
   const tasks = new Map<string, T>();
   for (const i of items) {
      const t = asTool(i);
      if (t) tasks.set(t.id, t);
   }
   const subagents = new Map<string, Subagent<T, I>>();
   const reportTs = new Map<string, number | null>();
   const rows: I[] = [];
   for (const i of items) {
      const t = asTool(i);
      const parent = t ? t.parent : (parentOf?.(i) ?? null);
      if (!parent || !tasks.has(parent)) {
         rows.push(i);
         continue;
      }
      let s = subagents.get(parent);
      if (!s) subagents.set(parent, (s = { calls: [], steps: [], report: null, endedAt: null }));
      if (t?.report != null) {
         s.report = t.report;
         reportTs.set(parent, t.ts ?? t.endedAt ?? null);
      } else {
         if (t) s.calls.push(t);
         s.steps.push(i);
      }
   }
   for (const [id, s] of subagents) {
      const task = tasks.get(id);
      s.endedAt = task?.background ? (reportTs.get(id) ?? null) : (task?.endedAt ?? null);
   }
   return { rows, subagents };
}

export type SubagentState = "running" | "done" | "failed";

/**
 * A background subagent is done when its report arrives; any other when its starting call ends. Some Agents never
 * send a background subagent's report (Claude's Explore agents), so without one it counts as running only while
 * `turnActive` (its Turn runs and is not waiting for the user).
 */
export function subagentState(task: SubagentTool, s: Subagent, turnActive = true): SubagentState {
   if (task.status === "failed") return "failed";
   if (s.report != null) return "done";
   if (task.status === "completed" && !task.background) return "done";
   return task.background && !turnActive ? "done" : "running";
}

/** A subagent's type, model and effort, as a Frontend keeps them from its starting call. */
export type SubagentLabel = {
   type: string | null;
   model: string | null;
   modelInherited: boolean;
   effort: string | null;
};

/** One subagent in a list (e.g. a Subagents panel). */
export type SubagentRow = {
   /** Its starting call's id. */
   id: string;
   title: string;
   type: string | null;
   model: string | null;
   modelInherited: boolean;
   effort: string | null;
   /** How many tool calls it made. */
   calls: number;
   state: SubagentState;
   startedAt: number | null;
   endedAt: number | null;
};

/**
 * The Session's subagents, running ones first, then newest first. `tools` are the tool calls (to find
 * each subagent's starting call); `turnActive` as in `subagentState`.
 */
export function listSubagents<
   T extends SubagentTool & { title: string; subagentMeta?: SubagentLabel | null },
>(tools: Iterable<T>, subagents: Map<string, Subagent>, turnActive = true): SubagentRow[] {
   const byId = new Map<string, T>();
   for (const t of tools) byId.set(t.id, t);
   const rows: SubagentRow[] = [];
   for (const [id, s] of subagents) {
      const task = byId.get(id);
      if (!task) continue;
      const m = task.subagentMeta;
      rows.push({
         id,
         title: task.title,
         type: m?.type ?? null,
         model: m?.model ?? null,
         modelInherited: m?.modelInherited ?? false,
         effort: m?.effort ?? null,
         calls: s.calls.length,
         state: subagentState(task, s, turnActive),
         startedAt: task.ts ?? null,
         endedAt: s.endedAt,
      });
   }
   const running = (r: SubagentRow) => (r.state === "running" ? 0 : 1);
   return rows.sort((a, b) => running(a) - running(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
