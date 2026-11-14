import type { PanelWidth } from "@harness/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { overlayHost } from "./overlayHost";
import { panelRoomStep, samePanels } from "./overlayMode";

/** The chat card's default width (logical px); `Mode::Chat.card()` in `overlay.rs`. */
const CHAT_CARD = 540;
const NO_PANELS: PanelWidth = { left: 0, right: 0 };

export function usePanelRoom() {
   // Side panels (Phase 2): the View says how much room its panels and stripes want beside the chat;
   // the host widens the window by that much, the card stays put. One host call at a time.
   // The card has a fixed width (`card`, only the resize grip changes it); the View draws a side's panels
   // only once `panelsHost` has room for them, so the window grows before a panel shows and a panel
   // hides before the window shrinks. The row is pinned to the window edge that does not move: the
   // right one while a left side changes (the host moves the left edge and resizes in one native step).
   const [card, setCard] = useState(CHAT_CARD);
   useEffect(() => {
      overlayHost
         .chatWidth()
         .then((w) => w && setCard(w))
         .catch((e) => console.error("overlay_chat_width failed", e));
   }, []);
   const [panelsWant, setPanelsWant] = useState<PanelWidth>(NO_PANELS);
   const [panelsHost, setPanelsHost] = useState<PanelWidth>(NO_PANELS);
   const [edge, setEdge] = useState<"left" | "right">("left");
   const panelsBusy = useRef(false);
   const onPanelWidth = useCallback(
      (w: PanelWidth) => setPanelsWant((p) => (samePanels(p, w) ? p : w)),
      [],
   );
   useEffect(() => {
      const step = panelRoomStep({
         busy: panelsBusy.current,
         want: panelsWant,
         host: panelsHost,
         edge,
      });
      if (step.type === "none") return;
      // The row is on its edge before the window changes.
      if (step.type === "edge") {
         setEdge(step.edge);
         return;
      }
      const w = step.to;
      panelsBusy.current = true;
      overlayHost
         .setPanels(w.left, w.right)
         .catch((e) => console.error("overlay_set_panels failed", e))
         .finally(() => {
            panelsBusy.current = false;
            setPanelsHost(w);
         });
   }, [panelsWant, panelsHost, edge]);
   return {
      card,
      setCard,
      panelsHost,
      edge,
      setEdge,
      onPanelWidth,
      resetPanels: () => setPanelsWant(NO_PANELS),
   };
}
