import {
   type GitToolSummary,
   gitToolSummary,
   type SubSessionToolSummary,
   subSessionToolSummary,
   type ToolRefFacts,
   toolDetail,
} from "@harness/api";
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

// [running, done, failed] for the Harness git tools.
const GIT_VERBS: Record<string, [string, string, string]> = {
   git_commit: ["Committing", "Committed", "Commit failed"],
   git_push: ["Pushing", "Pushed", "Push failed"],
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

/** What a Harness sub session step did (null for any other call). */
export function subSessionSummary(tool: Tool): SubSessionToolSummary | null {
   return subSessionToolSummary(tool);
}

/** What a Harness git step did (null for any other call). */
export function gitSummary(tool: Tool): GitToolSummary | null {
   return gitToolSummary(tool);
}

function gitDetail(name: string, g: GitToolSummary): string {
   switch (name) {
      case "git_commit":
         return g.subject ?? "";
      case "git_push":
         return g.branch ? `${g.branch} → origin` : "";
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
      const verb = live ? git[0] : state === "failed" ? git[2] : git[1];
      return { verb, detail: gitDetail(tool.harnessTool, gitSummary(tool) ?? {}) };
   }
   const sessionVerbs = tool.harnessTool ? SESSION_VERBS[tool.harnessTool] : undefined;
   if (sessionVerbs) {
      const s = subSessionSummary(tool) ?? {};
      const session = s.check ? CHECK_VERBS : sessionVerbs;
      const verb = live ? session[0] : state === "failed" ? session[2] : session[1];
      return { verb, detail: [s.title, s.repo].filter(Boolean).join(" · ") };
   }
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
