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

export function stepLabel(tool: Tool, state: StepState, subagent = false): StepLabel {
   const live = state === "running" || state === "pending";
   const pick = ([run, done]: [string, string]) => (live ? run : done);
   if (subagent) return { verb: pick(["Running subagent", "Ran subagent"]), detail: tool.title };
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
