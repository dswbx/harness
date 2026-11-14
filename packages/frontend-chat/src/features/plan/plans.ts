import { findModeOption, type PermissionOption } from "@harness/api";
import type { ConfigOption } from "../../state/reducer";
import { diffLines } from "../changes/diff";

/** Added and removed lines from one plan version to the next. */
export function planStats(prev: string, next: string): { add: number; del: number } {
   let add = 0;
   let del = 0;
   for (const l of diffLines(prev, next)) {
      if (l.op === "+") add++;
      else if (l.op === "-") del++;
   }
   return { add, del };
}

/** The config option that holds the Agent's mode (the core's rule, `findModeOption`). */
export const modeOption = (options: ConfigOption[]) => findModeOption(options) ?? null;

/**
 * The name of a mode value ("acceptEdits" -> "Accept Edits"): the mode option's, else the name the
 * core reported for it (`ChatState.modeNames`, for Agents with legacy modes), else the value itself.
 */
export function modeName(
   options: ConfigOption[],
   value: string | null | undefined,
   names?: Record<string, string>,
): string | null {
   if (!value) return null;
   return (
      modeOption(options)?.options.find((o) => o.value === value)?.name ?? names?.[value] ?? value
   );
}

const isAllow = (o: PermissionOption) => o.kind.startsWith("allow");

/**
 * The option the Approve button picks by default: the allow option that continues in the mode used
 * before Plan Mode and keeps the context; else the first allow_once option; else the first allow option.
 */
export function defaultApproveOption(
   options: PermissionOption[],
   modeBefore: string | null | undefined,
): PermissionOption | null {
   const allow = options.filter(isAllow);
   return (
      (modeBefore && allow.find((o) => o.plan_mode === modeBefore && !o.clears_context)) ||
      allow.find((o) => o.kind === "allow_once") ||
      allow[0] ||
      null
   );
}

/** The option that sends the Agent back to planning (Claude "No, keep planning", Codex `revise_plan`). */
export const keepPlanningOption = (options: PermissionOption[]) =>
   options.find((o) => o.kind.startsWith("reject")) ?? null;

/** A new pending plan opens the Plan panel, once per request (not in the Quick overlay). */
export function planToAutoOpen(
   overlay: boolean,
   pendingPlan: string | null,
   opened: ReadonlySet<string>,
): string | null {
   return overlay || !pendingPlan || opened.has(pendingPlan) ? null : pendingPlan;
}

/** "14:05" in the local time. */
export const clockTime = (ts: number) =>
   new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
