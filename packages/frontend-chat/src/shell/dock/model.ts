import { PANELS, zoneOfHint } from "../panels";

/**
 * Where the chat's panels sit: six zones, one open panel per zone and sizes. Panel ids are plain strings:
 * they come from the registry and the panel families, and a stored id nobody registers keeps its place.
 * Pure, so the rules (and the geometry the dock draws from) are testable. ADR 0019.
 */
export const ZONES = [
   "leftTop",
   "leftBottom",
   "bottomLeft",
   "bottomRight",
   "rightBottom",
   "rightTop",
] as const;
export type Zone = (typeof ZONES)[number];

export const ZONE_LABEL: Record<Zone, string> = {
   leftTop: "Left top",
   leftBottom: "Left bottom",
   bottomLeft: "Bottom left",
   bottomRight: "Bottom right",
   rightBottom: "Right bottom",
   rightTop: "Right top",
};

export const isLeftZone = (z: Zone) => z === "leftTop" || z === "leftBottom";
export const isRightZone = (z: Zone) => z === "rightTop" || z === "rightBottom";
export const isBottomZone = (z: Zone) => z === "bottomLeft" || z === "bottomRight";

export type Sizes = {
   /** Width of the left zones, of the right zones, height of the bottom zones (px). */
   left: number;
   right: number;
   bottom: number;
   /** Share of the sides' height the top zone takes when both halves are open; of the width the bottom-left zone takes when both bottom zones are open. */
   leftSplit: number;
   rightSplit: number;
   bottomSplit: number;
};

export type Layout = {
   /** Panels per zone, in stripe order. */
   zones: Record<Zone, string[]>;
   /** The panel shown in each zone. */
   open: Record<Zone, string | null>;
   sizes: Sizes;
   /** The panel grown to near full-screen (only while open). */
   expanded: string | null;
};

export const DEFAULT_SIZES: Sizes = {
   left: 280,
   right: 380,
   bottom: 240,
   leftSplit: 0.5,
   rightSplit: 0.55,
   bottomSplit: 0.5,
};

export const noOpen = (): Record<Zone, string | null> => ({
   leftTop: null,
   leftBottom: null,
   bottomLeft: null,
   bottomRight: null,
   rightBottom: null,
   rightTop: null,
});

export const noZones = (): Record<Zone, string[]> => ({
   leftTop: [],
   leftBottom: [],
   bottomLeft: [],
   bottomRight: [],
   rightBottom: [],
   rightTop: [],
});

/** The default places: every registered panel in its placement hint's zone, in the registry's order. */
export function defaultLayout(): Layout {
   const zones = noZones();
   for (const p of PANELS) zones[zoneOfHint(p.placement)].push(p.id);
   return {
      zones,
      open: noOpen(),
      sizes: { ...DEFAULT_SIZES },
      expanded: null,
   };
}

export function zoneOf(l: Layout, id: string): Zone | null {
   return ZONES.find((z) => l.zones[z].includes(id)) ?? null;
}

export const isOpen = (l: Layout, id: string) => ZONES.some((z) => l.open[z] === id);

/** The expanded panel only stays expanded while it is open. */
export function settle(l: Layout): Layout {
   return l.expanded && !isOpen(l, l.expanded) ? { ...l, expanded: null } : l;
}

const setOpen = (l: Layout, zone: Zone, id: string | null): Layout =>
   settle({ ...l, open: { ...l.open, [zone]: id } });

/** A stripe icon or shortcut: opens the panel in its zone, or hides it when it is the one shown there. */
export function toggle(l: Layout, id: string): Layout {
   const z = zoneOf(l, id);
   return z ? setOpen(l, z, l.open[z] === id ? null : id) : l;
}

/** Opens the panel in its zone (replacing what that zone showed). */
export function show(l: Layout, id: string): Layout {
   const z = zoneOf(l, id);
   return z && l.open[z] !== id ? setOpen(l, z, id) : l;
}

/** Hides the panel if it is open; it keeps its stripe icon. */
export function hide(l: Layout, id: string): Layout {
   const z = zoneOf(l, id);
   return z && l.open[z] === id ? setOpen(l, z, null) : l;
}

/**
 * Moves a panel to `zone`, at `index` of that zone's list as it was before the move (default: the end).
 * A panel that was open stays open in its new zone, replacing what that zone showed.
 */
export function move(l: Layout, id: string, to: Zone, index?: number): Layout {
   const from = zoneOf(l, id);
   if (!from) return l;
   const zones = { ...l.zones, [from]: l.zones[from].filter((p) => p !== id) };
   const at = l.zones[from].indexOf(id);
   const list = from === to ? zones[from] : [...l.zones[to]];
   let i = index ?? l.zones[to].length;
   if (from === to && i > at) i--;
   i = Math.max(0, Math.min(list.length, i));
   zones[to] = [...list.slice(0, i), id, ...list.slice(i)];
   const open = { ...l.open };
   if (open[from] === id) {
      open[from] = null;
      open[to] = id;
   }
   return settle({ ...l, zones, open });
}

/** Grows an open panel to near full-screen, or shrinks (null). */
export const expand = (l: Layout, id: string | null): Layout =>
   id === null
      ? l.expanded
         ? { ...l, expanded: null }
         : l
      : isOpen(l, id)
        ? { ...l, expanded: id }
        : l;

export const resize = (l: Layout, patch: Partial<Sizes>): Layout => ({
   ...l,
   sizes: { ...l.sizes, ...patch },
});

/** "Reset layout": default places and sizes. Nothing opens (the Side chats tabs are not part of it). */
export const resetLayout = (): Layout => defaultLayout();

/**
 * Makes the layout agree with the panels that exist. `known` is what the host runs, registered panels and
 * the instances of panel families, each with its default zone: the ones not placed yet go there. An id in
 * `zones` that is not known (a panel of a newer build, a family instance the Agent removed) keeps its
 * place; it just has no icon and does not render. Duplicates are dropped. Returns `l` itself when nothing changes.
 */
export function reconcile(l: Layout, known: { id: string; zone: Zone }[]): Layout {
   const seen = new Set<string>();
   const zones = {} as Record<Zone, string[]>;
   let changed = false;
   for (const z of ZONES) {
      zones[z] = l.zones[z].filter((id) => {
         const ok = !seen.has(id);
         if (ok) seen.add(id);
         else changed = true;
         return ok;
      });
   }
   for (const k of known) {
      if (!seen.has(k.id)) {
         zones[k.zone].push(k.id);
         seen.add(k.id);
         changed = true;
      }
   }
   const open = { ...l.open };
   for (const z of ZONES) {
      if (open[z] && !zones[z].includes(open[z]!)) {
         open[z] = null;
         changed = true;
      }
   }
   return changed ? settle({ ...l, zones, open }) : l;
}
