import {
   type GitToolSummary,
   gitToolSummary,
   type SubSessionToolSummary,
   subSessionToolSummary,
} from "@harness/api";
import type { Tool } from "./group";

export type StepState = "running" | "pending" | "done" | "failed";

/** A step's line: what it does, by state ("Running command" / "Ran command"), and on what (the title minus what the verb says). */
export type StepLabel = { verb: string; detail: string };

// [running, done], by ACP tool kind. Title prefixes the Agent already put in are cut from the detail.
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
const PREFIXED: [RegExp, [string, string]][] = [
   [/^Write /, ["Writing", "Wrote"]],
   [/^Search (?=")/, ["Searching web", "Searched web"]],
];
const PREFIX = /^(Read( file)?|Edit|Fetch) /;
// Titles that only name the tool, not what it runs on.
const BARE = new Set(["Terminal", "Read File", "Fetch", "Edit", "Web search"]);

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
   const mcp = /^mcp__(.+?)__(.+)$/.exec(tool.title);
   if (mcp) return { verb: pick([`Calling ${mcp[1]}`, `Called ${mcp[1]}`]), detail: mcp[2]! };
   const title = BARE.has(tool.title) ? "" : tool.title;
   for (const [re, verbs] of PREFIXED)
      if (re.test(title)) return { verb: pick(verbs), detail: title.replace(re, "") };
   const verbs = VERBS[tool.kind ?? ""];
   if (verbs) return { verb: pick(verbs), detail: title.replace(PREFIX, "") };
   return { verb: pick(["Calling", "Called"]), detail: tool.title };
}
