import { Suspense } from "react";
import type { HostedPanel } from "../usePanelHost";
import type { DockPanel } from "./DockLayout";

/** The hosted panels the dock keeps mounted: open ones, and (by their definition) once opened or while they can show. */
export function mountedPanels(
   entries: HostedPanel[],
   isShown: (id: string) => boolean,
   renderable: ReadonlySet<string>,
): DockPanel[] {
   const panels: DockPanel[] = [];
   for (const e of entries) {
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
