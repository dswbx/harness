import type { EventKind } from "../generated";

/** The mock Agent's asking mode (Codex "Read-only"): where Side Threads start. */
export const ASKING_MODE = "read-only";
export const isModeOption = (o: { id: string; category?: string }) =>
   o.category === "mode" || o.id === "mode";
/** Main's ConfigOptionsChanged with `side_mode` (like the core): the asking mode its mode option offers, else "default". */
export function withSideMode(kind: EventKind): EventKind {
   if (kind.type !== "ConfigOptionsChanged" || !Array.isArray(kind.options)) return kind;
   const mode = (
      kind.options as { id: string; category?: string; options?: { value: string }[] }[]
   ).find(isModeOption);
   if (!mode) return kind;
   const side_mode = mode.options?.some((v) => v.value === ASKING_MODE) ? ASKING_MODE : "default";
   return { ...kind, side_mode };
}
