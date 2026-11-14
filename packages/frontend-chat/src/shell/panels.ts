import { eventsPanel } from "../features/events/panel";
import { subagentsPanel } from "../features/subagents/panel";
import type { PanelDef, PlacementHint } from "../panels/contract";
import type { Zone } from "./panelLayout";

/**
 * The panels defined through the panel contract, in default order. The other built-in panels are
 * still wired by hand in `View.tsx` and move here one by one.
 */
// biome-ignore lint/suspicious/noExplicitAny: the registry holds panels of different model and target types
export const PANELS: readonly PanelDef<any, any>[] = [eventsPanel, subagentsPanel];

/** A registered panel by id. */
// biome-ignore lint/suspicious/noExplicitAny: as PANELS
export const panelDef = (id: string): PanelDef<any, any> | undefined =>
   PANELS.find((p) => p.id === id);

/** The dock zone a placement hint starts in. */
export function zoneOfHint(h: PlacementHint): Zone {
   if (h.edge === "left") return h.end ? "leftBottom" : "leftTop";
   if (h.edge === "bottom") return h.end ? "bottomRight" : "bottomLeft";
   return h.end ? "rightBottom" : "rightTop";
}
