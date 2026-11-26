import { clamp } from "@harness/ui";
import { isBottomZone, type Layout, type Sizes, ZONES, type Zone } from "./model";

/** Widths (px) of the open left and right columns: their stored sizes, 0 when nothing is open there. */
export function sideWidths(l: Layout): { left: number; right: number } {
   const o = l.open;
   return {
      left: o.leftTop || o.leftBottom ? l.sizes.left : 0,
      right: o.rightTop || o.rightBottom ? l.sizes.right : 0,
   };
}

export type Rect = { x: number; y: number; w: number; h: number };

export const MIN_CHAT = 360;
const MIN_LEFT = 180;
const MIN_RIGHT = 220;
const MIN_BOTTOM = 120;
/** Height the chat keeps above the bottom zones. */
const MIN_CHAT_H = 220;

export type Geometry = {
   /** Rect per zone that has an open panel. */
   zones: Partial<Record<Zone, Rect>>;
   chat: Rect;
   /** Widths of the left and right columns, height of the bottom row, height above it (all 0 when nothing is open). */
   left: number;
   right: number;
   bottom: number;
   top: number;
};

/**
 * Rects (px, in a `w` x `h` dock) of the chat and every open zone. Sides split their height when both
 * halves are open, the bottom splits its width only when both bottom zones are open and spans the full
 * width under the sides, the chat keeps at least 360 px (the side columns shrink together to fit).
 */
export function computeRects(l: Layout, w: number, h: number): Geometry {
   const o = l.open;
   const s = l.sizes;
   const hasL = !!(o.leftTop || o.leftBottom);
   const hasR = !!(o.rightTop || o.rightBottom);
   const hasB = !!(o.bottomLeft || o.bottomRight);
   const bottom = hasB ? clamp(s.bottom, MIN_BOTTOM, h - MIN_CHAT_H) : 0;
   const top = h - bottom;
   let left = hasL ? s.left : 0;
   let right = hasR ? s.right : 0;
   const room = Math.max(0, w - MIN_CHAT);
   if (left + right > room) {
      const k = room / (left + right);
      left = Math.round(left * k);
      right = Math.round(right * k);
   }
   const zones: Partial<Record<Zone, Rect>> = {};
   if (hasL) {
      if (o.leftTop && o.leftBottom) {
         const t = Math.round(top * s.leftSplit);
         zones.leftTop = { x: 0, y: 0, w: left, h: t };
         zones.leftBottom = { x: 0, y: t, w: left, h: top - t };
      } else zones[o.leftTop ? "leftTop" : "leftBottom"] = { x: 0, y: 0, w: left, h: top };
   }
   if (hasR) {
      if (o.rightTop && o.rightBottom) {
         const t = Math.round(top * s.rightSplit);
         zones.rightTop = { x: w - right, y: 0, w: right, h: t };
         zones.rightBottom = { x: w - right, y: t, w: right, h: top - t };
      } else
         zones[o.rightTop ? "rightTop" : "rightBottom"] = { x: w - right, y: 0, w: right, h: top };
   }
   if (hasB) {
      if (o.bottomLeft && o.bottomRight) {
         const bw = Math.round(w * s.bottomSplit);
         zones.bottomLeft = { x: 0, y: top, w: bw, h: bottom };
         zones.bottomRight = { x: bw, y: top, w: w - bw, h: bottom };
      } else zones[o.bottomLeft ? "bottomLeft" : "bottomRight"] = { x: 0, y: top, w, h: bottom };
   }
   return { zones, chat: { x: left, y: 0, w: w - left - right, h: top }, left, right, bottom, top };
}

export type ResizeKind = keyof Sizes;

/** The value a drag may set, given the current geometry of the dock. */
export function clampSize(kind: ResizeKind, v: number, g: Geometry, w: number, h: number): number {
   switch (kind) {
      case "left":
         return Math.round(clamp(v, MIN_LEFT, Math.max(MIN_LEFT, w - MIN_CHAT - g.right)));
      case "right":
         return Math.round(clamp(v, MIN_RIGHT, Math.max(MIN_RIGHT, w - MIN_CHAT - g.left)));
      case "bottom":
         return Math.round(clamp(v, MIN_BOTTOM, Math.max(MIN_BOTTOM, h - MIN_CHAT_H)));
      case "bottomSplit":
         return clamp(v, 0.2, 0.8);
      default:
         return clamp(v, 0.15, 0.85);
   }
}

/**
 * Drop targets while dragging: the six zones tiling the dock. Open sides and an open bottom keep their
 * real size, so a target lines up with the panel under it; closed ones take their stored size in the room left.
 * Without bottom zones in `zones` (the overlay) the sides take the full height.
 */
export function dropRects(
   l: Layout,
   w: number,
   h: number,
   zones: readonly Zone[] = ZONES,
): Record<Zone, Rect> {
   const g = computeRects(l, w, h);
   const s = l.sizes;
   const bottom =
      g.bottom ||
      (zones.some(isBottomZone)
         ? clamp(s.bottom, MIN_BOTTOM, Math.max(MIN_BOTTOM, h - MIN_CHAT_H))
         : 0);
   const top = h - bottom;
   const free = (size: number, other: number) =>
      Math.max(0, Math.min(size, Math.round((w - other) / 2)));
   const left = g.left || free(s.left, g.right);
   const right = g.right || free(s.right, left);
   const lt = Math.round(top * s.leftSplit);
   const rt = Math.round(top * s.rightSplit);
   const bw = Math.round(w * s.bottomSplit);
   return {
      leftTop: { x: 0, y: 0, w: left, h: lt },
      leftBottom: { x: 0, y: lt, w: left, h: top - lt },
      rightTop: { x: w - right, y: 0, w: right, h: rt },
      rightBottom: { x: w - right, y: rt, w: right, h: top - rt },
      bottomLeft: { x: 0, y: top, w: bw, h: bottom },
      bottomRight: { x: bw, y: top, w: w - bw, h: bottom },
   };
}

/**
 * The layout with what cannot render (no icon, no content) and what is `closed` here (open in a window of its
 * own) taken out of `open`, for geometry and drawing. The stored layout keeps it, so it comes back.
 */
export function shownOpen(
   l: Layout,
   renderable: ReadonlySet<string>,
   closed: ReadonlySet<string> = new Set(),
): Layout {
   let changed = false;
   const open = { ...l.open };
   for (const z of ZONES) {
      if (open[z] && (!renderable.has(open[z]!) || closed.has(open[z]!))) {
         open[z] = null;
         changed = true;
      }
   }
   if (!changed) return l;
   return {
      ...l,
      open,
      expanded: l.expanded && ZONES.some((z) => open[z] === l.expanded) ? l.expanded : null,
   };
}
