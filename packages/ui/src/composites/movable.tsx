import * as React from "react";
import { clamp } from "../lib/utils";
import { useDragDelta } from "./resizable";

/** A box in window pixels. */
export type Rect = { x: number; y: number; w: number; h: number };
export type Size = { w: number; h: number };
/** The edge or corner a resize handle sits on. */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** `r` kept inside the viewport: at least `min` (unless the viewport is smaller), never off-screen. */
export function clampRect(r: Rect, min: Size, view: Size): Rect {
   const w = Math.min(Math.max(r.w, min.w), view.w);
   const h = Math.min(Math.max(r.h, min.h), view.h);
   return {
      x: clamp(r.x, 0, view.w - w),
      y: clamp(r.y, 0, view.h - h),
      w,
      h,
   };
}

/** `start` resized from edge/corner `dir` by the pointer moving (dx, dy); the opposite edge stays put. */
export function resizeRect(
   start: Rect,
   dir: ResizeDir,
   dx: number,
   dy: number,
   min: Size,
   view: Size,
): Rect {
   let { x, y, w, h } = start;
   const right = start.x + start.w;
   const bottom = start.y + start.h;
   if (dir.includes("e")) w = clamp(start.w + dx, Math.min(min.w, view.w - x), view.w - x);
   if (dir.includes("w")) {
      x = clamp(start.x + dx, 0, Math.max(0, right - min.w));
      w = right - x;
   }
   if (dir.includes("s")) h = clamp(start.h + dy, Math.min(min.h, view.h - y), view.h - y);
   if (dir.includes("n")) {
      y = clamp(start.y + dy, 0, Math.max(0, bottom - min.h));
      h = bottom - y;
   }
   return clampRect({ x, y, w, h }, min, view);
}

/** Centered box of `size`, clamped to the viewport. */
export function centeredRect(size: Size, min: Size, view: Size): Rect {
   const w = Math.min(Math.max(size.w, min.w), view.w);
   const h = Math.min(Math.max(size.h, min.h), view.h);
   return clampRect(
      { x: Math.round((view.w - w) / 2), y: Math.round((view.h - h) / 2), w, h },
      min,
      view,
   );
}

const viewport = (): Size =>
   typeof window === "undefined"
      ? { w: 1280, h: 800 }
      : { w: window.innerWidth, h: window.innerHeight };

/** Elements inside the drag area that keep their own pointer behavior. */
const INTERACTIVE = "button, a, input, select, textarea, [role='button'], [contenteditable='true']";

const CURSOR: Record<ResizeDir, string> = {
   n: "ns-resize",
   s: "ns-resize",
   e: "ew-resize",
   w: "ew-resize",
   ne: "nesw-resize",
   sw: "nesw-resize",
   nw: "nwse-resize",
   se: "nwse-resize",
};

type Options = {
   /** Where the box is kept (per viewer): null when nothing is stored. Written on drag/resize end. */
   store: { get(): Rect | null; set(r: Rect): unknown };
   /** Size when nothing is stored (centered); clamped to the viewport. */
   initial: (view: Size) => Size;
   min: Size;
   /** True while shown (e.g. the dialog is open): placed from the store when it turns true, re-clamped on window resize. */
   active: boolean;
};

/**
 * A fixed-position box moved by a drag area and resized from its edges and corners, kept inside
 * the window and remembered per viewer. Put `style` on the box, `dragProps` on the drag area and
 * render `<ResizeHandles {...resize} />` inside the box.
 */
export function useMovableResizable({ store, initial, min, active }: Options) {
   const { w: minW, h: minH } = min;
   const latest = React.useRef({ store, initial });
   latest.current = { store, initial };
   /** The stored box, or `initial` centered, fitted to the window as it is now. */
   const load = React.useCallback((): Rect => {
      const view = viewport();
      const m = { w: minW, h: minH };
      const s = latest.current.store.get();
      return s ? clampRect(s, m, view) : centeredRect(latest.current.initial(view), m, view);
   }, [minW, minH]);
   const [rect, setRect] = React.useState<Rect>(load);
   const start = React.useRef(rect);
   const last = React.useRef(rect);
   const mode = React.useRef<ResizeDir | "move">("move");

   // Placed again on every open (the window may have changed size since): before paint, no jump.
   React.useLayoutEffect(() => {
      if (!active) return;
      const m = { w: minW, h: minH };
      const fit = () => setRect((r) => clampRect(r, m, viewport()));
      setRect(load());
      window.addEventListener("resize", fit);
      return () => window.removeEventListener("resize", fit);
   }, [active, minW, minH, load]);

   const onDown = useDragDelta({
      cursor: "grabbing",
      onStart: () => {
         start.current = last.current = rect;
      },
      onDelta: (dx, dy) => {
         const view = viewport();
         const s = start.current;
         last.current =
            mode.current === "move"
               ? clampRect({ ...s, x: s.x + dx, y: s.y + dy }, min, view)
               : resizeRect(s, mode.current, dx, dy, min, view);
         setRect(last.current);
      },
      onEnd: () => void store.set(last.current),
   });

   const begin = (m: ResizeDir | "move", e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      mode.current = m;
      onDown(e);
      // useDragDelta set its own cursor: the one for this handle wins until release.
      if (m !== "move") document.body.style.cursor = CURSOR[m];
   };

   const dragProps = {
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
         if ((e.target as Element).closest?.(INTERACTIVE)) return;
         begin("move", e);
      },
   };

   return {
      rect,
      style: {
         left: rect.x,
         top: rect.y,
         width: rect.w,
         height: rect.h,
      } satisfies React.CSSProperties,
      dragProps,
      resize: { onPointerDown: begin },
   };
}

const HANDLES: { dir: ResizeDir; className: string }[] = [
   { dir: "n", className: "inset-x-3 -top-1 h-2" },
   { dir: "s", className: "inset-x-3 -bottom-1 h-2" },
   { dir: "e", className: "inset-y-3 -right-1 w-2" },
   { dir: "w", className: "inset-y-3 -left-1 w-2" },
   { dir: "nw", className: "-left-1 -top-1 size-4" },
   { dir: "ne", className: "-right-1 -top-1 size-4" },
   { dir: "sw", className: "-bottom-1 -left-1 size-4" },
   { dir: "se", className: "-bottom-1 -right-1 size-4" },
];

/** Invisible strips on the box's edges and corners that resize it; they reach a little outside, so the box must not clip (`overflow-hidden`) them. */
export function ResizeHandles({
   onPointerDown,
}: {
   onPointerDown: (dir: ResizeDir, e: React.PointerEvent<HTMLElement>) => void;
}) {
   return (
      <>
         {HANDLES.map(({ dir, className }) => (
            <div
               key={dir}
               aria-hidden
               data-resize={dir}
               className={`absolute z-20 touch-none ${className}`}
               style={{ cursor: CURSOR[dir] }}
               onPointerDown={(e) => onPointerDown(dir, e)}
            />
         ))}
      </>
   );
}
