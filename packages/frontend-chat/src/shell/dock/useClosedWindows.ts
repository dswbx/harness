import { dockPanel, useClosedPanelWindows } from "@harness/api";
import { useEffect } from "react";
import { hide, isOpen, type Layout } from "./model";

/**
 * Main view only: the panels of `sessionId` whose window the user closed (red X) are hidden in their
 * zone, and once the layout shows them hidden (and saved it: `useDockLayout`'s effect runs first) their
 * key goes. A close while the main window showed another Session, or was not running, is applied when
 * this Session's view mounts.
 */
export function useClosedWindows(
   sessionId: string,
   on: boolean,
   lay: Layout,
   update: (f: (l: Layout) => Layout) => void,
) {
   const key = useClosedPanelWindows(sessionId)
      .map((w) => w.panel)
      .join("\n");
   useEffect(() => {
      if (!on || !key) return;
      const ids = key.split("\n");
      if (ids.some((id) => isOpen(lay, id))) {
         update((l) => ids.reduce(hide, l));
         return;
      }
      for (const id of ids) dockPanel(sessionId, id);
   }, [on, key, lay, sessionId, update]);
}
