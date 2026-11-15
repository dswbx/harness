import { type Layout, settle, ZONES, type Zone } from "./model";

/**
 * The Quick overlay's zones (ADR 0022): only the sides. Its window grows wider for side panels;
 * a bottom row would need it taller.
 */
export const OVERLAY_ZONES: readonly Zone[] = ["leftTop", "leftBottom", "rightBottom", "rightTop"];

/**
 * The layout in the overlay's zones: panels of the bottom zones go to the end of right bottom, and
 * one that was open there opens in right bottom (unless that shows one already). Returns `l` itself when nothing changes.
 */
export function overlayProfile(l: Layout): Layout {
   const z = l.zones;
   const o = l.open;
   if (!z.bottomLeft.length && !z.bottomRight.length && !o.bottomLeft && !o.bottomRight) return l;
   const zones = {
      ...z,
      rightBottom: [...z.rightBottom, ...z.bottomLeft, ...z.bottomRight],
      bottomLeft: [],
      bottomRight: [],
   };
   const open = {
      ...o,
      rightBottom: o.rightBottom ?? o.bottomLeft ?? o.bottomRight,
      bottomLeft: null,
      bottomRight: null,
   };
   return settle({ ...l, zones, open });
}

/** Width of an overlay stripe (its `w-10`, px). */
export const STRIPE_W = 40;

export type Sides<T> = { left: T; right: T };

export type OverlayGeometry = {
   /** What to draw: a side's panels show only when its room has space for them, at most that wide. */
   layout: Layout;
   /** The stripes to draw: only with room for them. */
   stripes: Sides<boolean>;
   /** The dock's width: drawn side columns, stripes and the chat card. */
   width: number;
   /** The dock's left offset in a row of `room.left + card + room.right`, so the card is at `room.left`. */
   offset: number;
};

/**
 * The Quick overlay's dock (ADR 0022 Phase 2). The chat card has a fixed width (`card`); the window's width
 * never changes it. `room` is what the host window has beside the card now; `l` and `stripes` are what the
 * View wants. A side grows the window first and draws its panels after (room too small: not drawn); a side
 * that shrinks stops drawing at once and the window follows. So the card never moves or reflows.
 */
export function overlayGeometry(
   l: Layout,
   room: Sides<number>,
   stripes: Sides<boolean>,
   card: number,
): OverlayGeometry {
   const o = { ...l.open };
   const sizes = { ...l.sizes };
   const drawn: Sides<boolean> = { left: false, right: false };
   const cols: Sides<number> = { left: 0, right: 0 };
   for (const side of ["left", "right"] as const) {
      drawn[side] = stripes[side] && room[side] >= STRIPE_W;
      const avail = room[side] - (drawn[side] ? STRIPE_W : 0);
      const [top, bottom] =
         side === "left"
            ? (["leftTop", "leftBottom"] as const)
            : (["rightTop", "rightBottom"] as const);
      if (!(o[top] || o[bottom])) continue;
      if (avail > 0) cols[side] = sizes[side] = Math.min(sizes[side], avail);
      else o[top] = o[bottom] = null;
   }
   const changed =
      ZONES.some((z) => o[z] !== l.open[z]) ||
      sizes.left !== l.sizes.left ||
      sizes.right !== l.sizes.right;
   const layout: Layout = changed
      ? {
           ...l,
           open: o,
           sizes,
           expanded: l.expanded && ZONES.some((z) => o[z] === l.expanded) ? l.expanded : null,
        }
      : l;
   const stripeL = drawn.left ? STRIPE_W : 0;
   const stripeR = drawn.right ? STRIPE_W : 0;
   return {
      layout,
      stripes: drawn,
      width: cols.left + stripeL + card + stripeR + cols.right,
      offset: room.left - cols.left - stripeL,
   };
}
