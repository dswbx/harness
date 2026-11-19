/**
 * What a Harness Task tool call (`task_add`, `task_update`; ADR 0028) did, read from its raw input and
 * the core's typed result (ADR 0012, shared helper). Parsing is defensive: anything unreadable just
 * leaves a field out.
 */
import type { TaskPriority, TaskStatus } from "../generated";
import { failure, type GitToolCall, harnessResult, textOf } from "./gitTool";
import { isTaskPriority, isTaskStatus } from "./tasks";

export const TASK_TOOLS = ["task_add", "task_update"] as const;

/** A Task the call added or changed. No `id` while the call has no result (running, failed). */
export type TaskToolRow = { id?: string; title: string; status?: TaskStatus };

/** What a `task_update` call asks to change, from its input. */
export type TaskToolChanges = {
   status?: TaskStatus;
   priority?: TaskPriority;
   /** null: cleared. */
   due?: string | null;
   /** The new parent's id; null: the top level. */
   parent?: string | null;
   title?: string;
   body?: boolean;
};

export type TaskToolSummary = {
   tool: (typeof TASK_TOOLS)[number];
   /** From the result; before it, from the input. */
   tasks: TaskToolRow[];
   /** task_update only. */
   changes?: TaskToolChanges;
   /** The first line of the failure text. */
   error?: string;
};

const str = (v: unknown): string | undefined =>
   typeof v === "string" && v.trim() ? v.trim() : undefined;
const statusOf = (v: unknown) => (isTaskStatus(v) ? v : undefined);
const record = (v: unknown) => (v && typeof v === "object" ? v : {}) as Record<string, unknown>;

export function taskToolSummary(tool: GitToolCall): TaskToolSummary | null {
   const name = tool.harnessTool;
   if (name !== "task_add" && name !== "task_update") return null;
   const input = record(tool.rawInput);
   const out: TaskToolSummary = { tool: name, tasks: [] };
   const error = [textOf(tool.content), textOf(tool.rawOutput)]
      .map((t) => (t === null ? undefined : failure(t)))
      .find((e) => e !== undefined);
   if (error) out.error = error;
   const result = harnessResult(tool);
   if (result?.type === "tasks") {
      out.tasks = result.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
   } else if (name === "task_add") {
      const list = Array.isArray(input.tasks) ? input.tasks : [];
      out.tasks = list.flatMap((v) => {
         const row = record(v);
         const title = str(row.title);
         if (!title) return [];
         const status = statusOf(row.status);
         return [{ title, ...(status && { status }) }];
      });
   } else {
      const id = str(input.id);
      if (id) out.tasks = [{ id, title: str(input.title) ?? id }];
   }
   if (name === "task_update") {
      const c: TaskToolChanges = {};
      const status = statusOf(input.status);
      if (status) c.status = status;
      if (isTaskPriority(input.priority)) c.priority = input.priority;
      if (typeof input.due === "string") c.due = str(input.due) ?? null;
      if ("parent" in input && (input.parent === null || typeof input.parent === "string"))
         c.parent = str(input.parent) ?? null;
      const title = str(input.title);
      if (title) c.title = title;
      if (typeof input.body === "string") c.body = true;
      out.changes = c;
   }
   return out;
}
