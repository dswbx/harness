import { useEffect } from "react";
import { type Layout, toggle } from "./dock/model";
import { PANELS } from "./panels";

/** The registered panels' global shortcuts (Cmd+J: the Terminal). */
export function useShortcuts(overlay: boolean, update: (f: (l: Layout) => Layout) => void) {
   useEffect(() => {
      // The Quick overlay has no Terminal.
      if (overlay) return;
      const onKey = (e: KeyboardEvent) => {
         // A registered panel's shortcut (Cmd+J: the Terminal). Capture phase, so xterm never sees it.
         const def = PANELS.find((p) => p.shortcut?.match(e));
         if (def) {
            e.preventDefault();
            e.stopPropagation();
            update((l) => toggle(l, def.id));
         }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
   }, [overlay, update]);
}
