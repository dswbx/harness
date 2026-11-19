import type { InstructionsEntry } from "@harness/api";

/**
 * For repositories that share a name with another one: the folder that holds each, so the
 * list can tell them apart (`/a/spark` → "a"). Keyed by path; unique names get no hint.
 */
export function repoHints(entries: InstructionsEntry[]): Map<string, string> {
   const count = new Map<string, number>();
   for (const e of entries)
      if (e.scope.type === "repo") count.set(e.name, (count.get(e.name) ?? 0) + 1);
   const hints = new Map<string, string>();
   for (const e of entries) {
      if (e.scope.type !== "repo" || (count.get(e.name) ?? 0) < 2) continue;
      const parts = e.scope.path.split(/[\\/]/).filter(Boolean);
      const parent = parts.at(-2);
      if (parent) hints.set(e.scope.path, parent);
   }
   return hints;
}
