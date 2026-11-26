import { focusPanelWindow, type SessionApi, type ViewVariant } from "@harness/api";
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
   PanelCtx,
   PanelDef,
   PanelFamily,
   PanelRef,
   PanelSelf,
   PanelStatus,
   PlacementHint,
} from "../panels/contract";
import type { ChatState } from "../state/reducer";
import { hide as hidePanel, isOpen, type Layout, show as showPanel, type Zone } from "./dock/model";
import { FAMILIES, PANELS, zoneOfHint } from "./panels";

type Target = { value: unknown; seq: number };

const sameStatus = (a: PanelStatus, b: PanelStatus) =>
   a.presence === b.presence && a.badge === b.badge && a.dot === b.dot && a.tip === b.tip;

export type PanelPlace = { id: string; zone: Zone };

/** One panel the host runs, whether registered or an instance of a family. */
export type HostedPanel = {
   id: string;
   label: string;
   /** None (a family's instance): the shell picks one for the place the panel is in. */
   icon?: ComponentType<{ className?: string }>;
   /** A family instance's icon name (`FamilyInstance.iconName`). */
   iconName?: string;
   placement: PlacementHint;
   expandable?: boolean;
   overlay: boolean;
   mount: "whenOpen" | "afterFirstOpen" | "whileReady";
   self: PanelSelf<unknown>;
   shortcut?: string[];
   /** Icon click while closed, when the panel has its own way (else the shell shows it). */
   activate?: () => void;
   // biome-ignore lint/suspicious/noExplicitAny: bodies of different model and target types
   Body: ComponentType<any>;
   /** What to render `Body` with. */
   props: Record<string, unknown>;
};

/**
 * The host side of the panel contract for the registered panels and the panel families: builds their
 * `PanelCtx` and `PanelSelf`, runs their `useModel` and reads their `status`. Every object keeps its identity
 * until one of its inputs changes. A panel's `self.open` is its place in the layout, whether or not it can show.
 */
export function usePanelHost(o: {
   api: SessionApi;
   state: ChatState;
   variant: ViewVariant;
   lay: Layout;
   update: (f: (l: Layout) => Layout) => void;
   chat: PanelCtx["chat"];
   host: PanelCtx["host"];
   /** The panels and families to host; constant lists (default: the registry). */
   // biome-ignore lint/suspicious/noExplicitAny: panels of different model and target types
   panels?: readonly PanelDef<any, any>[];
   // biome-ignore lint/suspicious/noExplicitAny: families of different model types
   families?: readonly PanelFamily<any>[];
   /** Panels open in a window of their own (not `popout`): opening one focuses that window. */
   popped?: ReadonlySet<string>;
   /** In a panel window: the panel it shows. Only that one can show here. */
   popout?: string;
}) {
   const { api, state, variant, lay, update, chat, host, panels = PANELS, families = FAMILIES } = o;
   const { popout } = o;
   const layRef = useRef(lay);
   layRef.current = lay;
   const poppedRef = useRef<ReadonlySet<string>>(new Set());
   poppedRef.current = o.popped ?? new Set();
   const sessionId = api.sessionId;
   const focusWindow = useCallback(
      (id: string) =>
         void focusPanelWindow(sessionId, id).catch((e) => console.error("focus window failed", e)),
      [sessionId],
   );
   const ctxRef = useRef<PanelCtx | null>(null);
   const [targets, setTargets] = useState<Record<string, Target>>({});
   const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

   const open = useCallback(
      (ref: PanelRef<unknown>, ...target: unknown[]) => {
         // Open in a window of its own: that window comes to the front (v1: without the target).
         if (poppedRef.current.has(ref.id)) {
            focusWindow(ref.id);
            return;
         }
         const def = panels.find((p) => p.id === ref.id);
         // A View that cannot show this panel (the Quick overlay, a panel window showing another panel)
         // hands the target to the panel's fallback instead; without one, a panel window does nothing.
         const cannotShow =
            popout !== undefined ? ref.id !== popout : variant === "overlay" && !def?.overlay;
         if (cannotShow && def?.fallback && target.length > 0) {
            def.fallback(ctxRef.current!, target[0]);
            return;
         }
         if (cannotShow && popout !== undefined) return;
         // A fresh object per call: the same value opened twice applies twice. Kept until the panel
         // mounts (hidden, or still loading), then applied once.
         if (target.length > 0)
            setTargets((t) => ({
               ...t,
               [ref.id]: { value: target[0], seq: (t[ref.id]?.seq ?? 0) + 1 },
            }));
         update((l) => showPanel(l, ref.id));
      },
      [update, variant, panels, popout, focusWindow],
   );
   const hide = useCallback(
      (ref: PanelRef<never>) => update((l) => hidePanel(l, ref.id)),
      [update],
   );
   const isOpenNow = useCallback((ref: PanelRef<never>) => isOpen(layRef.current, ref.id), []);
   const ctx = useMemo<PanelCtx>(
      () => ({
         api,
         state,
         variant,
         open: open as PanelCtx["open"],
         hide,
         isOpen: isOpenNow,
         chat,
         host,
      }),
      [api, state, variant, open, hide, isOpenNow, chat, host],
   );

   ctxRef.current = ctx;

   useEffect(() => {
      const fresh = panels.filter((p) => isOpen(lay, p.id) && !opened.has(p.id));
      if (fresh.length > 0) setOpened((s) => new Set([...s, ...fresh.map((p) => p.id)]));
   }, [lay, opened, panels]);

   const selvesRef = useRef(new Map<string, PanelSelf<unknown>>());
   /** A panel's `self`: the same object until its open state, first opening or target changes. */
   const selfOf = (id: string, withTarget: boolean) => {
      const next = {
         open: isOpen(lay, id),
         opened: opened.has(id),
         target: (withTarget && targets[id]) || null,
      };
      const prev = selvesRef.current.get(id);
      const same =
         prev &&
         prev.open === next.open &&
         prev.opened === next.opened &&
         prev.target === next.target;
      const self: PanelSelf<unknown> = same
         ? prev
         : {
              id,
              ...next,
              show: () =>
                 poppedRef.current.has(id) ? focusWindow(id) : update((l) => showPanel(l, id)),
              hide: () => update((l) => hidePanel(l, id)),
           };
      selvesRef.current.set(id, self);
      return self;
   };

   // The registry is a constant list, so the hooks run in the same order on every render.
   const selves: Record<string, PanelSelf<unknown>> = {};
   const models: Record<string, unknown> = {};
   for (const p of panels) {
      selves[p.id] = selfOf(p.id, true);
      // biome-ignore lint/correctness/useHookAtTopLevel: the panels never change
      models[p.id] = p.useModel(ctx, selves[p.id]!);
   }

   // The families likewise: one model each, and the instances listed from it (once per model).
   const familyModels: unknown[] = [];
   const familyInstances: ReturnType<PanelFamily["instances"]>[] = [];
   const instanceCache = useRef(new Map<PanelFamily, { model: unknown; list: unknown }>());
   for (const f of families) {
      // biome-ignore lint/correctness/useHookAtTopLevel: the families never change
      const model = f.useModel(ctx);
      familyModels.push(model);
      const hit = instanceCache.current.get(f);
      const list = hit && hit.model === model ? (hit.list as typeof hit.list) : f.instances(model);
      instanceCache.current.set(f, { model, list });
      familyInstances.push(list as ReturnType<PanelFamily["instances"]>);
   }
   const entries: HostedPanel[] = [];
   panels.forEach((p) => {
      const self = selves[p.id]!;
      const model = models[p.id];
      entries.push({
         id: p.id,
         label: p.label,
         icon: p.icon,
         placement: p.placement,
         expandable: p.expandable,
         overlay: !!p.overlay,
         mount: p.mount ?? "whenOpen",
         self,
         shortcut: p.shortcut?.keys,
         activate: p.activate && (() => p.activate!(model, self)),
         Body: p.Body as HostedPanel["Body"],
         props: { model, ctx, self },
      });
   });
   families.forEach((f, i) => {
      for (const inst of familyInstances[i]!) {
         const id = `${f.prefix}:${inst.key}`;
         const self = selfOf(id, false);
         selves[id] = self;
         entries.push({
            id: id,
            label: inst.label,
            icon: inst.icon,
            iconName: inst.iconName,
            placement: inst.placement,
            expandable: inst.expandable,
            overlay: !!inst.overlay,
            mount: "whenOpen",
            self,
            Body: f.Body,
            props: { model: familyModels[i], ctx, self, instance: inst.key },
         });
      }
   });
   // Instances that went away leave no `self` behind.
   for (const id of selvesRef.current.keys()) if (!(id in selves)) selvesRef.current.delete(id);

   // The places of every hosted panel, registered or an instance (for the layout to give new ones a zone),
   // the same array while they are the same.
   const placesRef = useRef<PanelPlace[]>([]);
   const places: PanelPlace[] = entries.map((e) => ({
      id: e.id,
      zone: zoneOfHint(e.placement),
   }));
   if (
      places.length !== placesRef.current.length ||
      places.some(
         (p, i) => p.id !== placesRef.current[i]!.id || p.zone !== placesRef.current[i]!.zone,
      )
   )
      placesRef.current = places;

   // What the Quick Overlay shows.
   const overlayRef = useRef<ReadonlySet<string>>(new Set());
   const overlayKey = entries.filter((e) => e.overlay).map((e) => e.id);
   if (
      overlayKey.length !== overlayRef.current.size ||
      overlayKey.some((id) => !overlayRef.current.has(id))
   )
      overlayRef.current = new Set(overlayKey);

   const statusesRef = useRef<ReadonlyMap<string, PanelStatus>>(new Map());
   const next = new Map<string, PanelStatus>(panels.map((p) => [p.id, p.status(models[p.id])]));
   families.forEach((f, i) => {
      familyInstances[i]!.forEach((inst) => next.set(`${f.prefix}:${inst.key}`, inst.status));
   });
   const prevStatuses = statusesRef.current;
   const statuses =
      next.size === prevStatuses.size &&
      [...next].every(([id, s]) => {
         const prev = prevStatuses.get(id);
         return prev && sameStatus(prev, s);
      })
         ? prevStatuses
         : next;
   statusesRef.current = statuses;

   return {
      ctx,
      selves,
      models,
      statuses,
      entries,
      places: placesRef.current,
      overlayIds: overlayRef.current as ReadonlySet<string>,
   };
}
