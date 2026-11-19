import {
   type GitToolSummary,
   gitToolSummary,
   type SubSessionToolSummary,
   subSessionToolSummary,
   type TaskToolSummary,
   type ToolRefFacts,
   taskToolSummary,
   toolDetail,
} from "@harness/api";
import { plural } from "../../lib/plural";
import type { Tool } from "./group";

export type StepState = "running" | "pending" | "done" | "failed";

/** A step's line: what it does, by state ("Running command" / "Ran command"), and on what (the title minus what the verb says). */
export type StepLabel = { verb: string; detail: string };

// [running, done], by ACP tool kind. The detail is the call's `target` (its title minus the verb the Agent put in).
const VERBS: Record<string, [string, string]> = {
   execute: ["Running command", "Ran command"],
   read: ["Reading", "Read"],
   edit: ["Editing", "Edited"],
   delete: ["Deleting", "Deleted"],
   move: ["Moving", "Moved"],
   search: ["Searching", "Searched"],
   fetch: ["Fetching", "Fetched"],
   switch_mode: ["Switching mode", "Switched mode"],
};
const OP_VERBS: Record<string, [string, string]> = {
   write: ["Writing", "Wrote"],
   web_search: ["Searching web", "Searched web"],
};

// The question a pending approval asks, by ACP tool kind; other tools: "Use tool?".
const ASK_VERBS: Record<string, string> = {
   execute: "Run command?",
   edit: "Edit?",
   delete: "Delete?",
   move: "Move?",
   read: "Read?",
   search: "Search?",
   fetch: "Fetch?",
};

/** The question a pending approval of this call asks ("Run command?"). */
export function askVerb(tool: Tool): string {
   const d = toolDetail(tool);
   if (d.op === "write") return "Write?";
   if (tool.harnessTool || d.mcp) return "Use tool?";
   return ASK_VERBS[tool.kind ?? ""] ?? "Use tool?";
}

// [running, done, failed] for the Harness git tools.
const GIT_VERBS: Record<string, [string, string, string]> = {
   git_commit: ["Committing", "Committed", "Commit failed"],
   git_push: ["Pushing", "Pushed", "Push failed"],
   pr_create: ["Opening pull request", "Opened PR", "PR failed"],
   git_status: ["Checking status", "Checked status", "Status failed"],
   git_diff: ["Reading diff", "Read diff", "Diff failed"],
   list_branches: ["Listing branches", "Listed branches", "List failed"],
};

// [running, done, failed] for the Harness sub session tools.
const SESSION_VERBS: Record<string, [string, string, string]> = {
   session_start: ["Starting sub session", "Started sub session", "Start failed"],
   session_send: ["Sending to sub session", "Sent to sub session", "Send failed"],
   session_wait: ["Waiting for sub session", "Waited for sub session", "Wait failed"],
   session_list: ["Listing sub sessions", "Listed sub sessions", "List failed"],
};
const CHECK_VERBS: [string, string, string] = [
   "Checking sub session",
   "Checked sub session",
   "Check failed",
];

/** What a Harness Task step did (`task_add`, `task_update`; null for any other call). */
export function taskSummary(tool: Tool): TaskToolSummary | null {
   return taskToolSummary(tool);
}

/** `Added 3 tasks` / `Updated task`, by state; the detail is the title of a single task. */
function taskLabel(t: TaskToolSummary, state: StepState): StepLabel {
   const live = state === "running" || state === "pending";
   const n = t.tasks.length;
   const detail = n === 1 ? (t.tasks[0]?.title ?? "") : "";
   if (t.tool === "task_add") {
      const verb = live
         ? n
            ? `Adding ${plural(n, "task")}`
            : "Adding tasks"
         : state === "failed"
           ? "Add failed"
           : `Added ${plural(n, "task")}`;
      return { verb, detail };
   }
   const verb = live ? "Updating task" : state === "failed" ? "Update failed" : "Updated task";
   return { verb, detail };
}

/** What a Harness sub session step did (null for any other call). */
export function subSessionSummary(tool: Tool): SubSessionToolSummary | null {
   return subSessionToolSummary(tool);
}

/** What a Harness git step did (null for any other call). */
export function gitSummary(tool: Tool): GitToolSummary | null {
   return gitToolSummary(tool);
}

function gitDetail(name: string, g: GitToolSummary, live: boolean): string {
   switch (name) {
      case "git_commit":
         return g.subject ?? "";
      case "git_push":
         return g.branch ? `${g.branch} → origin` : "";
      case "pr_create":
         return live && g.base && g.head ? `${g.base} ← ${g.head}` : (g.prTitle ?? "");
      case "git_status":
         return g.branch ?? "";
      case "git_diff":
         return g.range ?? "";
      default:
         return "";
   }
}

/** Tools a tool search call loaded (it loads deferred tool schemas so the Agent can call them); null for any other call. */
export function toolSearchTools(tool: Tool): ToolRefFacts[] | null {
   return toolDetail(tool).loadedTools;
}

/** `mcp__talat__get-summary` → `talat get-summary`. */
export const shortToolName = (t: ToolRefFacts) =>
   t.mcp ? `${t.mcp.server} ${t.mcp.tool}` : t.name;

export function stepLabel(tool: Tool, state: StepState, subagent = false): StepLabel {
   const live = state === "running" || state === "pending";
   const pick = ([run, done]: [string, string]) => (live ? run : done);
   if (subagent) return { verb: pick(["Running subagent", "Ran subagent"]), detail: tool.title };
   const git = tool.harnessTool ? GIT_VERBS[tool.harnessTool] : undefined;
   if (tool.harnessTool && git) {
      const g = gitSummary(tool) ?? {};
      const done = tool.harnessTool === "pr_create" && g.existing ? "Found PR" : git[1];
      const verb = live ? git[0] : state === "failed" ? git[2] : done;
      return { verb, detail: gitDetail(tool.harnessTool, g, live) };
   }
   const sessionVerbs = tool.harnessTool ? SESSION_VERBS[tool.harnessTool] : undefined;
   if (sessionVerbs) {
      const s = subSessionSummary(tool) ?? {};
      const session = s.check ? CHECK_VERBS : sessionVerbs;
      const verb = live ? session[0] : state === "failed" ? session[2] : session[1];
      return { verb, detail: [s.title, s.repo].filter(Boolean).join(" · ") };
   }
   const task = taskSummary(tool);
   if (task) return taskLabel(task, state);
   if (tool.harnessTool)
      return { verb: pick(["Calling Harness", "Called Harness"]), detail: tool.harnessTool };
   const d = toolDetail(tool);
   const loaded = d.loadedTools;
   if (loaded) {
      const keywords = d.searchQuery ?? "";
      const n = loaded.length;
      const verb = live
         ? "Loading tools"
         : n
           ? `Loaded ${n} tool${n === 1 ? "" : "s"}`
           : keywords
             ? "Searched tools"
             : "Loaded tools";
      return { verb, detail: keywords ? `"${keywords}"` : loaded.map(shortToolName).join(", ") };
   }
   const mcp = d.mcp;
   if (mcp)
      return { verb: pick([`Calling ${mcp.server}`, `Called ${mcp.server}`]), detail: mcp.tool };
   const prefixed = d.op && OP_VERBS[d.op];
   if (prefixed) return { verb: pick(prefixed), detail: d.target ?? tool.title };
   const verbs = VERBS[tool.kind ?? ""];
   if (verbs) return { verb: pick(verbs), detail: d.target ?? tool.title };
   return { verb: pick(["Calling", "Called"]), detail: tool.title };
}
