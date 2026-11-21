import { inTauri } from "@harness/api";
import { type Dispatch, useEffect, useState } from "react";
import { listenHost, type OverlayAnchor, overlayHost } from "./overlayHost";
import type { OverlayAction } from "./overlayMode";

/** What the host tells the overlay: each show (with where the prompt sits) and the shortcut. */
export function useHostSignals(dispatch: Dispatch<OverlayAction>) {
   // `shown` counts the host's shows: each one drops the menu room (the host did too).
   const [shown, setShown] = useState(0);
   const [anchor, setAnchor] = useState<OverlayAnchor>("top");
   // The host keeps the window hidden until `ready`, sent once `overlay-shown` is listened to (so
   // a shortcut that waited is not missed). Not requestAnimationFrame: WebKit does not run it in a
   // hidden window, and this window is made hidden at startup.
   // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is the reducer's, stable
   useEffect(
      () =>
         listenHost(
            "overlay-shown",
            (a) => {
               setAnchor(a === "bottom" ? "bottom" : "top");
               setShown((n) => n + 1);
               dispatch({ type: "shown" });
            },
            () => void overlayHost.ready(),
         ),
      [],
   );
   // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is the reducer's, stable
   useEffect(() => listenHost("overlay-shortcut", () => dispatch({ type: "shortcut" })), []);
   // The browser mock (`?overlay=1`) has no host to show the window: it shows at once.
   // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is the reducer's, stable
   useEffect(() => {
      if (!inTauri()) dispatch({ type: "shown" });
   }, []);
   return { shown, anchor };
}
