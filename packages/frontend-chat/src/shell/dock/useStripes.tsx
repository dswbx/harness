import { PanelLeft, PanelRight } from "lucide-react";
import { useMemo } from "react";
import type { PanelStatus } from "../../panels/contract";
import type { PanelMenuModel } from "../../panels/PanelHeader";
import type { HostedPanel } from "../usePanelHost";
import { stripeGroup } from "../viewState";
import {
   expand,
   isOpen,
   type Layout,
   move,
   movePopped,
   toggle,
   ZONE_LABEL,
   ZONES,
   type Zone,
   zoneOf,
} from "./model";
import type { PanelHint } from "./panelRecord";
import type { StripeGroup } from "./Stripe";

/**
 * The stripes' content: one group per zone (the available panels of the zone, with their label, icon,
 * tip, badge, shortcut and "changed" dot), and what a stripe icon does.
 */
export function useStripes(o: {
   entries: HostedPanel[];
   statuses: ReadonlyMap<string, PanelStatus>;
   /** The layout (every panel placed) and what is shown of it. */
   lay: Layout;
   shown: Layout;
   available: ReadonlySet<string>;
   update: (f: (l: Layout) => Layout) => void;
   /** Labels and icons of recorded panels the host does not list yet (before the log is here). */
   hints?: ReadonlyMap<string, PanelHint>;
   /** Panels open in a window of their own: a window badge, and a click focuses that window. */
   popped?: ReadonlySet<string>;
   onFocusWindow?: (id: string) => void;
   /** Docks a popped panel back (its rail menu's Dock back). */
   onDockBack?: (id: string) => void;
   /** Opens a panel in a window of its own (its rail menu's Move to › New window). Absent: not offered. */
   onPopOut?: (id: string) => void;
   /** The zones Move to offers. Default all six; the Quick overlay offers only the sides. */
   zones?: readonly Zone[];
}) {
   const { entries, statuses, lay, shown, available, update, hints, popped, onFocusWindow } = o;
   const { onDockBack, onPopOut, zones = ZONES } = o;
   const entryOf = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
   const label = (id: string) => entryOf.get(id)?.label ?? hints?.get(id)?.label ?? id;
   // A panel without an icon of its own (a render_ui one without `icon`) gets the one of the side it is on.
   const icon = (id: string) => {
      const Own = entryOf.get(id)?.icon ?? (entryOf.has(id) ? undefined : hints?.get(id)?.icon);
      if (Own) return <Own />;
      return lay.zones.leftTop.includes(id) || lay.zones.leftBottom.includes(id) ? (
         <PanelLeft />
      ) : (
         <PanelRight />
      );
   };
   const tip = (id: string) =>
      popped?.has(id) ? `${label(id)} · in its own window` : (statuses.get(id)?.tip ?? label(id));
   const count = (id: string) => statuses.get(id)?.badge;
   const shortcut = (id: string) => entryOf.get(id)?.shortcut;
   const dotOf = (id: string) => statuses.get(id)?.dot;
   const group = (zone: Zone): StripeGroup => {
      const g = stripeGroup(zone, {
         zones: lay.zones,
         openIn: shown.open[zone],
         available,
         dot: dotOf,
         label,
         tip,
         count,
         shortcut,
         icon,
      });
      if (!popped?.size) return g;
      return { zone, items: g.items.map((it) => ({ ...it, popped: popped.has(it.id) })) };
   };
   const left: [StripeGroup, StripeGroup, StripeGroup] = [
      group("leftTop"),
      group("leftBottom"),
      group("bottomLeft"),
   ];
   const right: [StripeGroup, StripeGroup, StripeGroup] = [
      group("rightTop"),
      group("rightBottom"),
      group("bottomRight"),
   ];
   const leftEmpty = left.every((g) => g.items.length === 0);

   /** A stripe icon: focuses the window of a popped panel; hides the panel when it is shown, else the panel's own way to show (Side chats: its last chat), else shows it. */
   const onToggle = (id: string) => {
      if (popped?.has(id)) {
         onFocusWindow?.(id);
         return;
      }
      const entry = entryOf.get(id);
      if (!isOpen(shown, id) && entry?.activate) entry.activate();
      else update((l) => toggle(l, id));
   };

   /** The host part of a stripe icon's context menu: the same entries as the panel's ⋮ menu. */
   const menuOf = (id: string): PanelMenuModel => {
      const home = zoneOf(lay, id);
      const isPopped = !!popped?.has(id);
      const expanded = shown.expanded === id;
      return {
         moves: zones.map((z) => ({ id: z, label: ZONE_LABEL[z], current: z === home })),
         onMove: (z) => update((l) => (isPopped ? movePopped : move)(l, id, z as Zone)),
         expand:
            entryOf.get(id)?.expandable && isOpen(shown, id)
               ? { expanded, onToggle: () => update((l) => expand(l, expanded ? null : id)) }
               : undefined,
         onPopOut: onPopOut && (() => onPopOut(id)),
         window: isPopped
            ? { onShow: () => onFocusWindow?.(id), onDockBack: () => onDockBack?.(id) }
            : undefined,
      };
   };
   return { left, right, leftEmpty, icon, onToggle, menuOf };
}
