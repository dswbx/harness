import { useEffect, useRef, useState } from "react";
import { overlayHost } from "./overlayHost";
import { menuRoomStep, type OverlayMode } from "./overlayMode";

/**
 * Open menus, popovers and lists (Radix portals them into `body`; the prompt's "/" and "#" menus
 * are lists in the box). Tooltips do not count: they fit and should not move the window.
 */
const MENU =
   "[data-radix-popper-content-wrapper]:has([role=menu],[role=listbox],[role=dialog]), [role=listbox]";

/** True while a menu is open in this page (checked once per frame after DOM changes). */
function useMenuOpen(): boolean {
   const [open, setOpen] = useState(false);
   useEffect(() => {
      let frame = 0;
      const check = () => {
         frame = 0;
         setOpen(!!document.querySelector(MENU));
      };
      const mo = new MutationObserver(() => {
         if (!frame) frame = requestAnimationFrame(check);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      return () => {
         mo.disconnect();
         cancelAnimationFrame(frame);
      };
   }, []);
   return open;
}

/** The card's size (logical px) pinned while a menu has the window grown; null: not pinned. */
export function useMenuRoom({
   visible,
   mode,
   shown,
}: {
   visible: boolean;
   mode: OverlayMode;
   /** The host's shows so far: each one drops the room (the host did too). */
   shown: number;
}) {
   // A web page cannot draw outside its window: while a menu is open the host grows the window
   // right and down (its top-left stays, so the card does not move). The card keeps its size: it is
   // pinned to the window size from before, then unpinned once the window is back.
   const want = useMenuOpen() && visible;
   const [pin, setPin] = useState<{ w: number; h: number } | null>(null);
   // One host call at a time; `held`: no new room until the menus close (after a show or mode change).
   const room = useRef({ busy: false, grown: false, held: false });
   const [synced, setSynced] = useState(0);
   // biome-ignore lint/correctness/useExhaustiveDependencies: a show or a mode change drops the room on the host side.
   useEffect(() => {
      room.current.grown = false;
      room.current.held = true;
      setPin(null);
   }, [mode, shown]);
   // biome-ignore lint/correctness/useExhaustiveDependencies: `synced` re-runs it after each host call.
   useEffect(() => {
      const r = room.current;
      const step = menuRoomStep(r, want, !!pin);
      r.held = step.held;
      if (r.busy) return;
      const call = (open: boolean) => {
         r.busy = true;
         overlayHost
            .setMenuRoom(open)
            .catch((e) => console.error("overlay_set_menu_room failed", e))
            .finally(() => {
               r.busy = false;
               r.grown = open;
               if (!open) setPin(null);
               setSynced((n) => n + 1);
            });
      };
      if (step.act === "open") call(true);
      // The pin is on the page before the window grows.
      else if (step.act === "pin") setPin({ w: window.innerWidth, h: window.innerHeight });
      else if (step.act === "close") call(false);
      else if (step.act === "unpin") setPin(null);
   }, [want, pin, synced]);
   return { pin };
}
