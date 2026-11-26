import { Suspense } from "react";
import { PanelHeader } from "../../panels/PanelHeader";
import type { HostedPanel } from "../usePanelHost";
import type { DockPanel } from "./DockLayout";
import { PopoutPlaceholder } from "./PopoutPlaceholder";

/**
 * The hosted panels the dock keeps mounted: open ones, and (by their definition) once opened or while they
 * can show. A panel in `placeholders` (id to label: recorded, its model not loaded yet) shows only an empty
 * frame with its header while shown, never its body. A panel in `popout.ids` is open in its own window: while
 * shown, its zone has its header and a `PopoutPlaceholder`, never its body (one live copy only).
 */
export function mountedPanels(
   entries: HostedPanel[],
   isShown: (id: string) => boolean,
   renderable: ReadonlySet<string>,
   placeholders: ReadonlyMap<string, string> = new Map(),
   popout?: { sessionId: string; ids: ReadonlySet<string> },
): DockPanel[] {
   const panels: DockPanel[] = [];
   const popped = popout?.ids ?? new Set<string>();
   const poppedPanel = (id: string, label: string): DockPanel => ({
      id,
      label,
      popped: true,
      children: (
         <>
            <PanelHeader title={label} />
            <PopoutPlaceholder sessionId={popout!.sessionId} panelId={id} label={label} />
         </>
      ),
   });
   for (const [id, label] of placeholders) {
      if (!isShown(id)) continue;
      if (popped.has(id)) {
         panels.push(poppedPanel(id, label));
         continue;
      }
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
      if (placeholders.has(e.id)) continue;
      if (popped.has(e.id)) {
         if (isShown(e.id)) panels.push(poppedPanel(e.id, e.label));
         continue;
      }
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
