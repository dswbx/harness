import { Suspense } from "react";
import { PanelHeader } from "../../panels/PanelHeader";
import type { HostedPanel } from "../usePanelHost";
import type { DockPanel } from "./DockLayout";

/**
 * The hosted panels the dock keeps mounted: open ones, and (by their definition) once opened or while they
 * can show. A panel in `placeholders` (id to label: recorded, its model not loaded yet) shows only an empty
 * frame with its header while shown, never its body. A panel in `popped` is open in its own window: never
 * mounted here (one live copy only; its zone shows as if it were hidden).
 */
export function mountedPanels(
   entries: HostedPanel[],
   isShown: (id: string) => boolean,
   renderable: ReadonlySet<string>,
   placeholders: ReadonlyMap<string, string> = new Map(),
   popped: ReadonlySet<string> = new Set(),
): DockPanel[] {
   const panels: DockPanel[] = [];
   for (const [id, label] of placeholders) {
      if (!isShown(id) || popped.has(id)) continue;
      panels.push({
         id,
         label,
         children: (
            <>
               <PanelHeader title={label} />
               <div aria-busy className="min-h-0 flex-1" />
            </>
         ),
      });
   }
   for (const e of entries) {
      if (placeholders.has(e.id) || popped.has(e.id)) continue;
      const mounted =
         e.mount === "afterFirstOpen"
            ? e.self.opened
            : e.mount === "whileReady"
              ? renderable.has(e.id)
              : isShown(e.id);
      if (!mounted) continue;
      const Body = e.Body;
      panels.push({
         id: e.id,
         label: e.label,
         expandable: e.expandable,
         children: (
            <Suspense fallback={null}>
               <Body {...e.props} />
            </Suspense>
         ),
      });
   }
   return panels;
}
