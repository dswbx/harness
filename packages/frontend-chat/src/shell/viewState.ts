import { type Slot, slotChangeKey } from "../features/renderUi/slots";
import type { PanelStatus } from "../panels/contract";
import {
   isDraftThread,
   type Layout,
   openThread,
   type PanelId,
   replaceThread,
   type Zone,
} from "./panelLayout";
import type { StripeGroup } from "./Stripe";

/** Pure decisions of the chat View: which panels exist, the stripes, what opens by itself, the Side Thread tabs. */

/** Panels that can show now. The Quick overlay shows only render_ui panels (ADR 0022 Phase 2). */
export function availablePanels(o: {
   overlay: boolean;
   slotPanels: Iterable<PanelId>;
   git: boolean;
   hasPlans: boolean;
   hasSubagents?: boolean;
   /** The status of each panel defined through the panel contract: it decides, instead of the hand-written rules. */
   registered?: ReadonlyMap<string, PanelStatus>;
}): Set<PanelId> {
   if (o.overlay) return new Set<PanelId>(o.slotPanels);
   const a = new Set<PanelId>([
      "side",
      "files",
      "terminal",
      "events",
      "artifacts",
      "references",
      ...o.slotPanels,
   ]);
   if (o.git) a.add("changes");
   if (o.hasPlans) a.add("plan");
   if (o.hasSubagents) a.add("subagents");
   for (const [id, s] of o.registered ?? []) {
      if (s.presence === "absent") a.delete(id as PanelId);
      else a.add(id as PanelId);
   }
   return a;
}

/** The available panels that can render: the side chats panel needs an open tab. */
export function renderablePanels(
   available: ReadonlySet<PanelId>,
   openThreadCount: number,
): Set<PanelId> {
   const renderable = new Set(available);
   if (openThreadCount === 0) renderable.delete("side");
   return renderable;
}

/** The badge on a panel's stripe icon. */
export function panelCount(
   id: PanelId,
   n: {
      sideThreads: number;
      artifacts: number;
      references: number | undefined;
      runningSubagents: number;
   },
): number | undefined {
   return id === "side"
      ? n.sideThreads
      : id === "artifacts"
        ? n.artifacts
        : id === "references"
          ? n.references
          : id === "subagents"
            ? n.runningSubagents || undefined
            : undefined;
}

/** A dot on a slot's icon: changed since it was seen, while closed. */
export function slotDot(
   slot: Slot | undefined,
   on: boolean,
   seen: Record<string, string>,
   stamps: Record<string, { hash: string }>,
): boolean {
   return !!slot && !on && slot.id in seen && seen[slot.id] !== slotChangeKey(slot, stamps);
}

/**
 * One stripe group: the zone's panels that are available, in order. `index` is the position in the
 * zone's full list. `on`: the zone's open panel.
 */
export function stripeGroup<I>(
   zone: Zone,
   o: {
      zones: Record<Zone, PanelId[]>;
      openIn: PanelId | null;
      available: ReadonlySet<PanelId>;
      slotById: ReadonlyMap<PanelId, Slot>;
      seen: Record<string, string>;
      stamps: Record<string, { hash: string }>;
      label: (id: PanelId) => string;
      tip: (id: PanelId) => string;
      count: (id: PanelId) => number | undefined;
      shortcut: (id: PanelId) => string[] | undefined;
      icon: (id: PanelId) => I;
   },
): { zone: Zone; items: (Omit<StripeGroup["items"][number], "icon"> & { icon: I })[] } {
   return {
      zone,
      items: o.zones[zone].flatMap((id, index) => {
         if (!o.available.has(id)) return [];
         const slot = o.slotById.get(id);
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
               dot: slotDot(slot, on, o.seen, o.stamps),
            },
         ];
      }),
   };
}

/**
 * The "seen" map after a render: a slot's first sight counts as seen, and one that is open follows
 * its changes. A file-backed slot whose file was not read yet is skipped. Same object when nothing changed.
 */
export function nextSeen(
   prev: Record<string, string>,
   slots: readonly Slot[],
   stamps: Record<string, { hash: string }>,
   isShared: (source: string | null) => boolean,
   isOpen: (slot: Slot) => boolean,
): Record<string, string> {
   let next = prev;
   for (const slot of slots) {
      if (slot.source && !isShared(slot.source) && !(slot.source in stamps) && !(slot.id in prev))
         continue;
      const k = slotChangeKey(slot, stamps);
      if ((isOpen(slot) || !(slot.id in prev)) && prev[slot.id] !== k)
         next = { ...next, [slot.id]: k };
   }
   return next;
}

/** The newest slot (first one on a tie). */
export function lastSlot(slots: readonly Slot[]): Slot | null {
   return slots.reduce<Slot | null>((a, x) => (!a || x.ts > a.ts ? x : a), null);
}

/** A slot the Agent placed or changed after the Session was opened shows at once (replayed ones do not). */
export function slotToAutoOpen(last: Slot | null, openedAt: number): Slot | null {
   return last && last.ts >= openedAt ? last : null;
}

/** A new pending plan opens the Plan panel, once per request (not in the Quick overlay). */
export function planToAutoOpen(
   overlay: boolean,
   pendingPlan: string | null,
   opened: ReadonlySet<string>,
): string | null {
   return overlay || !pendingPlan || opened.has(pendingPlan) ? null : pendingPlan;
}

/** Open Side Thread tabs that have something to show: drafts, and Threads whose replay arrived. */
export function openThreadIds(
   threads: readonly string[],
   known: Record<string, unknown>,
): string[] {
   return threads.filter((id) => isDraftThread(id) || !!known[id]);
}

/** The Side Thread shown: the selected one if open, else the last open one. */
export function activeThreadId(selected: string | null, open: readonly string[]): string | null {
   return selected && open.includes(selected) ? selected : (open.at(-1) ?? null);
}

/** The tab "new side chat" shows: an open draft is reused. */
export function newThreadTabId(l: Layout, uuid: () => string): string {
   return l.threads.find(isDraftThread) ?? `draft:${uuid()}`;
}

/** A Side Thread started: it takes the draft tab's place when there is one, else a new tab. */
export function threadStarted(l: Layout, draft: string | undefined, threadId: string): Layout {
   return draft && l.threads.includes(draft)
      ? replaceThread(l, draft, threadId)
      : openThread(l, threadId);
}
