import {
   type GitToolSummary,
   type SubSessionToolSummary,
   subagentState,
   type ToolRefFacts,
   toolDetail,
} from "@harness/api";
import { formatDuration } from "../../lib/time";
import { diffLines } from "../changes/diff";
import type { ChatSubagent, Tool } from "./group";
import { gitSummary, type StepState, stepLabel, subSessionSummary, toolSearchTools } from "./label";
import { hasRaw } from "./raw";

/** Which icon a step shows; the Trace display maps it to a component. */
export type StepIcon =
   | "bot"
   | "failed"
   | "git_commit"
   | "git_push"
   | "git_status"
   | "git_diff"
   | "list_branches"
   | "blocks"
   | "plug"
   | "read"
   | "edit"
   | "delete"
   | "move"
   | "search"
   | "execute"
   | "think"
   | "fetch"
   | "switch_mode"
   | "wrench";

const GIT_ICONS = new Set<string>([
   "git_commit",
   "git_push",
   "git_status",
   "git_diff",
   "list_branches",
]);
const KIND_ICONS = new Set<string>([
   "read",
   "edit",
   "delete",
   "move",
   "search",
   "execute",
   "think",
   "fetch",
   "switch_mode",
]);

/** A sub session that is not idle (`session_wait`, `session_list`). */
export const SUB_STATUS = { needs_attention: "needs attention", working: "still working" } as const;

const APPROVAL_META = {
   you: "allowed by you",
   rule: "allowed by rule",
   auto: "auto mode",
   denied: "denied",
} as const;

/** A chip after a step's title: text, or `+a -d` line counts (green and red). */
export type StepMeta = string | { add: number; del: number };

/** What a step opens to; `none` when it has nothing to show (the line has no toggle). */
export type StepBody =
   | { kind: "none" }
   | { kind: "subagent"; subagent: ChatSubagent }
   | { kind: "subSession"; summary: SubSessionToolSummary }
   | { kind: "toolSearch"; tools: ToolRefFacts[] }
   | { kind: "commit"; message: string; hash: string | undefined }
   | { kind: "call" };

export type StepView = {
   state: StepState;
   /** The line's status mark: running shimmer, error colour, dimmed. */
   lineStatus: "running" | "error" | "pending" | undefined;
   icon: StepIcon;
   verb: string;
   detail: string;
   /** Short commit hash, shown as a badge after the title. */
   hash: string | undefined;
   metas: StepMeta[];
   body: StepBody;
};

export type StepViewInput = {
   tool: Tool;
   /** What this call started, when it started a subagent. */
   subagent?: ChatSubagent;
   /** A Turn is running. */
   active: boolean;
   /** The Turn waits for the user (a permission or plan is pending). */
   waiting: boolean;
};

/** `+3 -1` over the call's diffs. */
export function diffStat(tool: Tool): { add: number; del: number } | null {
   let add = 0;
   let del = 0;
   for (const b of tool.content) {
      if (b.type !== "diff") continue;
      for (const l of diffLines(b.oldText as string | null, String(b.newText ?? ""))) {
         if (l.op === "+") add++;
         else if (l.op === "-") del++;
      }
   }
   return add || del ? { add, del } : null;
}

function iconOf(
   tool: Tool,
   state: StepState,
   subagent: ChatSubagent | undefined,
   sub: SubSessionToolSummary | null,
   loaded: ToolRefFacts[] | null,
): StepIcon {
   if (subagent) return "bot";
   if (state === "failed") return "failed";
   if (tool.harnessTool && GIT_ICONS.has(tool.harnessTool)) return tool.harnessTool as StepIcon;
   if (sub) return "bot";
   if (loaded) return "blocks";
   if (tool.harnessTool || toolDetail(tool).mcp) return "plug";
   return KIND_ICONS.has(tool.kind ?? "") ? (tool.kind as StepIcon) : "wrench";
}

function metasOf(
   tool: Tool,
   state: StepState,
   subagent: ChatSubagent | undefined,
   denied: boolean,
   git: GitToolSummary | null,
   sub: SubSessionToolSummary | null,
): StepMeta[] {
   // Live count for a subagent (never its last call: a long one pushed the title out).
   const n = subagent?.calls.length ?? 0;
   const approval = tool.approval && !subagent ? APPROVAL_META[tool.approval] : null;
   const metas: (StepMeta | false | null | undefined)[] = subagent
      ? [`${n} tool call${n === 1 ? "" : "s"}`]
      : state === "failed"
        ? [git?.error ?? sub?.error ?? "failed"]
        : denied
          ? ["denied"]
          : state === "pending"
            ? ["stopped"]
            : [
                 git?.changed !== undefined && `${git.changed} changed`,
                 git?.count !== undefined && `${git.count} branch${git.count === 1 ? "" : "es"}`,
                 git?.additions !== undefined && { add: git.additions, del: git.deletions ?? 0 },
                 sub?.sessions &&
                    `${sub.sessions.length} sub session${sub.sessions.length === 1 ? "" : "s"}`,
                 sub?.status && sub.status !== "idle" && SUB_STATUS[sub.status],
                 sub?.durationMs !== undefined && formatDuration(sub.durationMs),
                 diffStat(tool),
                 approval,
              ];
   return metas.filter((m): m is StepMeta => !!m);
}

/** Everything the Trace display shows of one tool call, derived in one place. */
export function stepView({ tool, subagent, active, waiting }: StepViewInput): StepView {
   const denied = !subagent && tool.approval === "denied";
   const state: StepState = subagent
      ? subagentState(tool, subagent, active && !waiting)
      : denied
        ? "pending"
        : tool.status === "failed"
          ? "failed"
          : tool.status === "completed"
            ? "done"
            : active
              ? "running"
              : "pending";
   const git = subagent ? null : gitSummary(tool);
   const sub = subagent ? null : subSessionSummary(tool);
   const loaded = subagent ? null : toolSearchTools(tool);
   const { verb, detail } = stepLabel(tool, state, !!subagent);
   const message = tool.commitMessage ?? "";
   const hasBody = !!subagent || !!message || tool.content.length > 0 || hasRaw(tool);
   const body: StepBody = !hasBody
      ? { kind: "none" }
      : subagent
        ? { kind: "subagent", subagent }
        : sub
          ? { kind: "subSession", summary: sub }
          : loaded?.length
            ? { kind: "toolSearch", tools: loaded }
            : message
              ? { kind: "commit", message, hash: git?.hash }
              : { kind: "call" };
   return {
      state,
      lineStatus:
         state === "running"
            ? "running"
            : state === "failed"
              ? "error"
              : state === "pending"
                ? "pending"
                : undefined,
      icon: iconOf(tool, state, subagent, sub, loaded),
      verb,
      detail,
      hash: git?.hash,
      metas: metasOf(tool, state, subagent, denied, git, sub),
      body,
   };
}
