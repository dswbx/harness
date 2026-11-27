import { takePanelOpen, usePanelOpens } from "@harness/api";
import { useEffect, useRef } from "react";
import type { PanelCtx, PanelRef } from "../../panels/contract";
import type { DockMode } from "./useDockLayout";

/**
 * The panel inbox of one View (ADR 0030): applies the opens another window sent for a panel this View
 * owns, each once through `open`, then removes its key. Owner: the main view owns the panels that are
 * not popped, a panel window only its own panel, the Quick overlay none. An open for a panel this View
 * does not host (yet, like a slot made just before) stays until it is hosted or stale.
 */
export function useInbox(o: {
   sessionId: string;
   mode: DockMode;
   /** In a panel window: the panel it shows. */
   popout?: string;
   /** Panels open in a window of their own (not `popout`). */
   popped: ReadonlySet<string>;
   /** The ids of the panels this View hosts. */
   hosted: readonly string[];
   open: PanelCtx["open"];
}) {
   const { sessionId, mode, popout, popped, hosted, open } = o;
   const opens = usePanelOpens(sessionId);
   const hostedKey = hosted.join("\n");
   // The opens already applied (`panel@at`): once only, also before the key removal is seen.
   const applied = useRef(new Set<string>());
   useEffect(() => {
      if (mode === "overlay" || opens.length === 0) return;
      const ids = new Set(hostedKey.split("\n"));
      const owns = (id: string) =>
         ids.has(id) && (mode === "window" ? id === popout : !popped.has(id));
      const send = open as (ref: PanelRef<unknown>, ...target: unknown[]) => void;
      for (const e of opens) {
         if (!owns(e.panel)) continue;
         const seen = `${e.panel}@${e.at}`;
         if (!applied.current.has(seen)) {
            applied.current.add(seen);
            if ("target" in e) send({ id: e.panel }, e.target);
            else send({ id: e.panel });
         }
         takePanelOpen(sessionId, e.panel);
      }
   }, [sessionId, mode, popout, popped, hostedKey, opens, open]);
}
