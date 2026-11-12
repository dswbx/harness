import type { PermissionOption } from "@harness/api";
import { diffLines } from "./diff";
import type { ConfigOption } from "./reducer";

/** The first `#` heading of a plan, without the hashes. Null when the plan has none. */
export function planTitle(md: string): string | null {
   const m = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(md);
   return m ? m[1]!.trim() : null;
}

const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * The number of steps in a plan: the top-level list items under a heading that names steps
 * ("Steps", "Implementation steps"), else all top-level list items. Null when there are none.
 */
export function planSteps(md: string): number | null {
   const lines = md.split("\n");
   let inFence = false;
   let section: { level: number; steps: boolean } | null = null;
   let underSteps = 0;
   let all = 0;
   for (const l of lines) {
      if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
      if (inFence) continue;
      const h = HEADING.exec(l);
      if (h) {
         const level = h[1]!.length;
         if (section?.steps && level > section.level) continue;
         section = { level, steps: /\bsteps?\b/i.test(h[2]!) };
         continue;
      }
      if (!LIST_ITEM.test(l)) continue;
      all++;
      if (section?.steps) underSteps++;
   }
   const n = underSteps || all;
   return n > 0 ? n : null;
}

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

/** The config option that holds the Agent's mode (Claude `mode`; Codex `mode`, its approval preset). */
export const modeOption = (options: ConfigOption[]) =>
   options.find((o) => o.category === "mode") ?? null;

/** The name of a mode value ("acceptEdits" -> "Accept Edits"), or the value itself when it is unknown. */
export function modeName(options: ConfigOption[], value: string | null | undefined): string | null {
   if (!value) return null;
   return modeOption(options)?.options.find((o) => o.value === value)?.name ?? value;
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

/** "14:05" in the local time. */
export const clockTime = (ts: number) =>
   new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
