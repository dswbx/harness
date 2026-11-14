import { cn } from "@harness/ui";
import { useRef } from "react";
import { overlayHost } from "./overlayHost";

/** Transparent margin around the card for its shadow (logical px); `SHADOW` in `overlay.rs`. */
export const SHADOW = 20;

export const CORNERS = ["topLeft", "topRight", "bottomLeft", "bottomRight"] as const;
type Corner = (typeof CORNERS)[number];
const CORNER_CLASS: Record<Corner, string> = {
   topLeft: "top-0 left-0 cursor-nwse-resize",
   topRight: "top-0 right-0 cursor-nesw-resize",
   bottomLeft: "bottom-0 left-0 cursor-nesw-resize",
   bottomRight: "bottom-0 right-0 cursor-nwse-resize",
};

/**
 * An invisible resize corner of the chat. A borderless macOS window has no resize edges, so the drag
 * is here: screen deltas from the card's size (plus its shadow margin) at the start, one host call
 * per frame (the opposite corner kept). Side panels keep their widths; the host adds them.
 */
export function ResizeGrip({
   corner,
   onStart,
   onCard,
}: {
   corner: Corner;
   onStart: () => void;
   /** The card's width after the host resized the window (the window grows first, then the card). */
   onCard: (width: number) => void;
}) {
   const left = corner.endsWith("Left");
   const top = corner.startsWith("top");
   // A left or top corner grows the card as the pointer moves left or up.
   const sx = left ? -1 : 1;
   const sy = top ? -1 : 1;
   const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
   const next = useRef<[number, number] | null>(null);
   const frame = useRef(0);
   const send = () => {
      frame.current = 0;
      if (next.current)
         overlayHost
            .resize(...next.current, left, top)
            .then((w) => w && onCard(w))
            .catch((e) => console.error("overlay_resize failed", e));
      next.current = null;
   };
   const end = () => {
      drag.current = null;
      cancelAnimationFrame(frame.current);
      send();
   };
   return (
      <div
         role="separator"
         aria-label="Resize"
         className={cn("absolute z-10 size-3 touch-none", CORNER_CLASS[corner])}
         onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            onStart();
            const card = e.currentTarget.parentElement!;
            drag.current = {
               x: e.screenX,
               y: e.screenY,
               w: card.offsetWidth + 2 * SHADOW,
               h: card.offsetHeight + 2 * SHADOW,
            };
         }}
         onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            next.current = [d.w + sx * (e.screenX - d.x), d.h + sy * (e.screenY - d.y)];
            if (!frame.current) frame.current = requestAnimationFrame(send);
         }}
         onPointerUp={end}
         onPointerCancel={end}
      />
   );
}
