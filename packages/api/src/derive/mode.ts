import type { EventKind, ModeInfo } from "../generated";

/**
 * The Agent mode and the context usage of an Event. The core fills `mode` (on `ConfigOptionsChanged`
 * and `ModeChanged`), `used` and `size` (on `UsageUpdated`); this is the one fallback for Session
 * Logs recorded before it did (ADR 0021). It implements the core's rule: a mode option is one with
 * `category == "mode"` or `id == "mode"`, and a legacy `ModeChanged` announces a mode too.
 *
 * Remove the fallback (the `legacy` branches, the raw `usage` read, and the `plan` id test) once no Session Log recorded before the core wrote these fields has to be shown.
 */

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object";

/** The mode an Event announces, or null when it announces none. `legacy`: derived here, not typed by the core. */
export function announcedMode(kind: EventKind): { mode: ModeInfo; legacy: boolean } | null {
   if (kind.type === "ConfigOptionsChanged") {
      if (kind.mode) return { mode: kind.mode, legacy: false };
      if (!Array.isArray(kind.options)) return null;
      const opt = (kind.options as unknown[]).find(
         (o): o is Raw => isObj(o) && (o.category === "mode" || o.id === "mode"),
      );
      if (typeof opt?.currentValue !== "string") return null;
      const id = opt.currentValue;
      const named = Array.isArray(opt.options)
         ? (opt.options as unknown[]).find((o) => isObj(o) && o.value === id)
         : undefined;
      const name = isObj(named) && typeof named.name === "string" ? named.name : undefined;
      return { mode: { id, name, plan: legacyIsPlan(id) }, legacy: true };
   }
   if (kind.type === "ModeChanged") {
      if (kind.mode) return { mode: kind.mode, legacy: false };
      if (!kind.mode_id) return null;
      return { mode: { id: kind.mode_id, plan: legacyIsPlan(kind.mode_id) }, legacy: true };
   }
   return null;
}

/** Old logs only: the core flags the plan mode itself (`ModeInfo.plan`). */
const legacyIsPlan = (id: string) => id === "plan";

/** The context usage of a `UsageUpdated`, or null when it carries no numbers. */
export function usageOf(kind: EventKind): { used: number; size: number } | null {
   if (kind.type !== "UsageUpdated") return null;
   if (typeof kind.used === "number" && typeof kind.size === "number")
      return { used: kind.used, size: kind.size };
   const u = isObj(kind.usage) ? kind.usage : {};
   return typeof u.used === "number" && typeof u.size === "number"
      ? { used: u.used, size: u.size }
      : null;
}
