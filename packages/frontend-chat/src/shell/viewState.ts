import type { PanelStatus } from "../panels/contract";
import type { Zone } from "./dock/model";
import type { StripeGroup } from "./dock/Stripe";

/** Pure decisions of the chat View: which panels exist and the stripes. */

/**
 * Panels with an icon: those whose status is not `absent` (registered panels and render_ui panels alike).
 * The Quick overlay shows only those marked `overlay` (`overlayPanels`, ADR 0022 Phase 2).
 */
export function availablePanels(o: {
   overlay: boolean;
   /** The status of each panel (shell/usePanelHost.ts). */
   statuses: ReadonlyMap<string, PanelStatus>;
   /** The panels the Quick overlay shows. */
   overlayPanels?: ReadonlySet<string>;
}): Set<string> {
   const a = new Set<string>();
   for (const [id, s] of o.statuses) {
      if (o.overlay && !o.overlayPanels?.has(id)) continue;
      if (s.presence !== "absent") a.add(id);
   }
   return a;
}

/** The available panels that can render: those whose status is `ready` (an `icon` one has nothing to show). */
export function renderablePanels(
   available: ReadonlySet<string>,
   statuses: ReadonlyMap<string, PanelStatus>,
): Set<string> {
   return new Set([...available].filter((id) => statuses.get(id)?.presence === "ready"));
}

/**
 * One stripe group: the zone's panels that are available, in order. `index` is the position in the
 * zone's full list. `on`: the zone's open panel.
 */
export function stripeGroup<I>(
   zone: Zone,
   o: {
      zones: Record<Zone, string[]>;
      openIn: string | null;
      available: ReadonlySet<string>;
      /** Changed while closed. */
      dot: (id: string) => boolean | undefined;
      label: (id: string) => string;
      tip: (id: string) => string;
      count: (id: string) => number | undefined;
      shortcut: (id: string) => string[] | undefined;
      icon: (id: string) => I;
   },
): { zone: Zone; items: (Omit<StripeGroup["items"][number], "icon"> & { icon: I })[] } {
   return {
      zone,
      items: o.zones[zone].flatMap((id, index) => {
         if (!o.available.has(id)) return [];
         const on = o.openIn === id;
         return [
            {
               id,
               index,
               label: o.label(id),
               tip: o.tip(id),
               count: o.count(id),
               shortcut: o.shortcut(id),
               icon: o.icon(id),
               on,
               dot: !!o.dot(id),
            },
         ];
      }),
   };
}
