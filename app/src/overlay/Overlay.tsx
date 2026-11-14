import type { OverlayFrame, Transport } from "@harness/api";
import { HarnessClient as Client } from "@harness/api";
import { Badge, cn } from "@harness/ui";
import { Maximize2, Minus, X, Zap } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useReportError } from "../platform/toast";
import { ViewHost } from "../platform/ViewHost";
import { IconButton, MiniBar } from "./MiniBar";
import { overlayHost } from "./overlayHost";
import { INITIAL_OVERLAY, overlayReducer } from "./overlayMode";
import { CORNERS, ResizeGrip, SHADOW } from "./ResizeGrip";
import { useHostSignals } from "./useHostSignals";
import { useMenuRoom } from "./useMenuRoom";
import { usePanelRoom } from "./usePanelRoom";
import { useQuickDraft } from "./useQuickDraft";
import { useWindowContextChip } from "./useWindowContextChip";

/**
 * The Quick overlay window (`?overlay=1`, ADR 0022): a draft Quick Session's prompt box, then the
 * pinned chat, or the mini bar. One more Frontend window of the core; `overlay.rs` places it.
 */
export function Overlay({ transport }: { transport: Transport }) {
   const [client] = useState(() => new Client(transport));
   const report = useReportError();
   const [s, dispatch] = useReducer(overlayReducer, INITIAL_OVERLAY);
   const modeRef = useRef(s.mode);
   modeRef.current = s.mode;

   const { shown, anchor } = useHostSignals(dispatch);
   const { context, reset: resetContext } = useWindowContextChip(s.mode);

   // The host follows the state: the window size per mode, hidden when `visible` turns false.
   useEffect(() => overlayHost.setMode(s.mode), [s.mode]);
   const wasVisible = useRef(false);
   useEffect(() => {
      if (wasVisible.current && !s.visible) overlayHost.hide();
      wasVisible.current = s.visible;
   }, [s.visible]);

   const { pin } = useMenuRoom({ visible: s.visible, mode: s.mode, shown });
   const { card, setCard, panelsHost, edge, setEdge, onPanelWidth, resetPanels } = usePanelRoom();
   const { draft, title, error, agentSwitch, close, merge } = useQuickDraft({
      client,
      report,
      visible: s.visible,
      mode: s.mode,
      dispatch,
      onReset: () => {
         resetContext();
         resetPanels();
      },
   });

   // Cmd+M switches chat and mini; Esc minimizes (on the prompt: hides). Open menus keep their Esc.
   useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
         if (e.defaultPrevented) return;
         if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "m") {
            e.preventDefault();
            dispatch({ type: modeRef.current === "mini" ? "expand" : "minimize" });
         } else if (
            e.key === "Escape" &&
            !document.querySelector("[data-radix-popper-content-wrapper], [role=dialog]")
         ) {
            dispatch({ type: "minimize" });
         }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
   }, []);

   // Below the mouse the prompt box is at the top of its window (it grows down); at the bottom of
   // the screen it is at the bottom.
   const promptAtTop = s.mode === "prompt" && anchor === "top";

   const chat = s.mode === "chat";
   const overlayFrame = useMemo<OverlayFrame>(
      () => ({ card, room: panelsHost }),
      [card, panelsHost],
   );
   // The menu room and the resize grip grow the window right and down: the row keeps its left edge.
   const rowAt = pin ? "left" : edge;
   // The chat card: header, the View's chat column, resize grip. The View puts its panels outside it.
   const chatFrame = (column: ReactNode) => (
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-overlay">
         <div
            data-tauri-drag-region
            className="flex h-11 shrink-0 items-center gap-2 border-b pl-3 pr-1.5"
         >
            <Badge variant="secondary" data-tauri-drag-region className="gap-1">
               <Zap className="size-3" /> Quick
            </Badge>
            <span data-tauri-drag-region className="min-w-0 flex-1 truncate text-sm font-medium">
               {title}
            </span>
            <IconButton label="Minimize (⌘M)" onClick={() => dispatch({ type: "minimize" })}>
               <Minus />
            </IconButton>
            <IconButton label="Open in main window" onClick={merge}>
               <Maximize2 />
            </IconButton>
            <IconButton label="Close" onClick={close}>
               <X />
            </IconButton>
         </div>
         {column}
         {chat &&
            CORNERS.map((c) => (
               <ResizeGrip
                  key={c}
                  corner={c}
                  // The row keeps to the window edge that does not move.
                  onStart={() => setEdge(c.endsWith("Left") ? "right" : "left")}
                  onCard={(w) => setCard((x) => (x === w ? x : w))}
               />
            ))}
      </div>
   );

   return (
      <div
         className="h-full overflow-hidden"
         style={{ padding: SHADOW, ...(pin && { width: pin.w, height: pin.h }) }}
      >
         {s.mode === "mini" && (
            <MiniBar
               title={title}
               newReply={s.newReply}
               onClose={close}
               onExpand={() => dispatch({ type: "expand" })}
            />
         )}
         <div
            className={cn(
               "relative h-full",
               !chat && "flex flex-col",
               s.mode === "mini" && "hidden",
            )}
         >
            <div
               className={cn(chat ? "absolute inset-y-0" : cn("min-h-0", !promptAtTop && "flex-1"))}
               style={
                  chat
                     ? { width: panelsHost.left + card + panelsHost.right, [rowAt]: 0 }
                     : undefined
               }
            >
               {draft ? (
                  <ViewHost
                     transport={transport}
                     sessionId={draft.id}
                     frontendId={draft.frontendId}
                     variant="overlay"
                     agentSwitch={agentSwitch}
                     chatFrame={chatFrame}
                     onPanelWidth={onPanelWidth}
                     overlayFrame={chat ? overlayFrame : undefined}
                     context={context}
                  />
               ) : (
                  error && (
                     <div
                        className={cn(
                           "flex h-full px-6 pb-3.5",
                           promptAtTop ? "items-start" : "items-end",
                        )}
                     >
                        <p
                           role="alert"
                           className="w-full rounded-2xl border bg-card p-3 text-sm text-destructive shadow-overlay"
                        >
                           {error}
                        </p>
                     </div>
                  )
               )}
            </div>
         </div>
      </div>
   );
}
