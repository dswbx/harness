import type { PromptContext } from "@harness/api";
import { useEffect, useMemo, useState } from "react";
import { listenHost, overlayHost } from "./overlayHost";
import type { OverlayMode } from "./overlayMode";
import {
   contextAction,
   contextAttachment,
   contextDetail,
   contextKey,
   contextLabel,
   type WindowContext,
} from "./windowContext";

export function useWindowContextChip(mode: OverlayMode) {
   // What the user is looking at in other apps (Phase 3). While the overlay shows the prompt the
   // host sends each change; the chip shows only there, and the first message sends it. In the chat
   // (and mini) the host stops polling, there is no chip and later messages send no context.
   // A removed chip stays removed for that app, window and page; another one shows it again.
   const [windowCtx, setWindowCtx] = useState<WindowContext | null>(null);
   const [dismissed, setDismissed] = useState<string | null>(null);
   useEffect(() => {
      const take = (c: unknown) => {
         const next = (c as WindowContext | null) ?? null;
         setWindowCtx(next);
         if (next) setDismissed((d) => (d === contextKey(next) ? d : null));
      };
      overlayHost
         .context()
         .then(take)
         .catch((e) => console.error("overlay_context failed", e));
      return listenHost("overlay-context", take);
   }, []);
   const context = useMemo<PromptContext | undefined>(() => {
      if (mode !== "prompt") return undefined;
      if (!windowCtx || contextKey(windowCtx) === dismissed) return undefined;
      const action = contextAction(windowCtx);
      return {
         label: contextLabel(windowCtx),
         detail: contextDetail(windowCtx),
         attachment: contextAttachment(windowCtx),
         onRemove: () => setDismissed(contextKey(windowCtx)),
         action: action && {
            label: action.label,
            onClick: () => overlayHost.openPrivacySettings(action.pane),
         },
      };
   }, [windowCtx, dismissed, mode]);
   /** Forget the context and the dismissal (the overlay was closed or merged). */
   const reset = () => {
      setWindowCtx(null);
      setDismissed(null);
   };
   return { context, reset };
}
