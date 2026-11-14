import { artifactsPanel } from "../features/artifacts/panel";
import { changesPanel } from "../features/changes/panel";
import { eventsPanel } from "../features/events/panel";
import { filesPanel } from "../features/files/panel";
import { planPanel } from "../features/plan/panel";
import { referencesPanel } from "../features/references/panel";
import { slotPanels } from "../features/renderUi/slotPanels";
import { sideChatsPanel } from "../features/sideChats/panel";
import { subagentsPanel } from "../features/subagents/panel";
import { terminalPanel } from "../features/terminal/panel";
import type { PanelDef, PanelFamily, PlacementHint } from "../panels/contract";
import type { Zone } from "./panelLayout";

/** The panels defined through the panel contract, in default order (within a zone). */
// biome-ignore lint/suspicious/noExplicitAny: the registry holds panels of different model and target types
export const PANELS: readonly PanelDef<any, any>[] = [
   changesPanel,
   filesPanel,
   sideChatsPanel,
   planPanel,
   artifactsPanel,
   referencesPanel,
   terminalPanel,
   eventsPanel,
   subagentsPanel,
];

/** The panel families: panels the Agent creates at runtime. */
// biome-ignore lint/suspicious/noExplicitAny: the registry holds families of different model types
export const FAMILIES: readonly PanelFamily<any>[] = [slotPanels];

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
