import type { SessionApi, ViewVariant } from "@harness/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelCtx, PanelRef, PanelSelf, PanelStatus } from "../panels/contract";
import type { ChatState } from "../state/reducer";
import {
   hide as hidePanel,
   isOpen,
   type Layout,
   type PanelId,
   show as showPanel,
} from "./panelLayout";
import { PANELS } from "./panels";

type Target = { value: unknown; seq: number };

const sameStatus = (a: PanelStatus, b: PanelStatus) =>
   a.presence === b.presence && a.badge === b.badge && a.dot === b.dot && a.tip === b.tip;

/**
 * The host side of the panel contract for the registered panels: builds their `PanelCtx` and
 * `PanelSelf`, runs their `useModel` and reads their `status`. Every object keeps its identity until
 * one of its inputs changes. A panel's `self.open` is its place in the layout, whether or not it can show.
 */
export function usePanelHost(o: {
   api: SessionApi;
   state: ChatState;
   variant: ViewVariant;
   lay: Layout;
   update: (f: (l: Layout) => Layout) => void;
   chat: PanelCtx["chat"];
   host: PanelCtx["host"];
}) {
   const { api, state, variant, lay, update, chat, host } = o;
   const layRef = useRef(lay);
   layRef.current = lay;
   const [targets, setTargets] = useState<Record<string, Target>>({});
   const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

   const open = useCallback(
      (ref: PanelRef<unknown>, ...target: unknown[]) => {
         if (target.length > 0)
            setTargets((t) => ({
               ...t,
               [ref.id]: { value: target[0], seq: (t[ref.id]?.seq ?? 0) + 1 },
            }));
         update((l) => showPanel(l, ref.id as PanelId));
      },
      [update],
   );
   const hide = useCallback(
      (ref: PanelRef<never>) => update((l) => hidePanel(l, ref.id as PanelId)),
      [update],
   );
   const isOpenNow = useCallback(
      (ref: PanelRef<never>) => isOpen(layRef.current, ref.id as PanelId),
      [],
   );
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

   useEffect(() => {
      const fresh = PANELS.filter((p) => isOpen(lay, p.id as PanelId) && !opened.has(p.id));
      if (fresh.length > 0) setOpened((s) => new Set([...s, ...fresh.map((p) => p.id)]));
   }, [lay, opened]);

   const selvesRef = useRef(new Map<string, PanelSelf<unknown>>());
   const selves: Record<string, PanelSelf<unknown>> = {};
   for (const p of PANELS) {
      const next = {
         open: isOpen(lay, p.id as PanelId),
         opened: opened.has(p.id),
         target: targets[p.id] ?? null,
      };
      const prev = selvesRef.current.get(p.id);
      const same =
         prev &&
         prev.open === next.open &&
         prev.opened === next.opened &&
         prev.target === next.target;
      const self = same
         ? prev
         : {
              id: p.id,
              ...next,
              show: () => update((l) => showPanel(l, p.id as PanelId)),
              hide: () => update((l) => hidePanel(l, p.id as PanelId)),
           };
      selvesRef.current.set(p.id, self);
      selves[p.id] = self;
   }

   // The registry is a constant list, so the hooks run in the same order on every render.
   const models: Record<string, unknown> = {};
   for (const p of PANELS) {
      // biome-ignore lint/correctness/useHookAtTopLevel: PANELS never changes
      models[p.id] = p.useModel(ctx, selves[p.id]!);
   }

   const statusesRef = useRef<ReadonlyMap<string, PanelStatus>>(new Map());
   const next = new Map(PANELS.map((p) => [p.id, p.status(models[p.id])]));
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

   return { ctx, selves, models, statuses };
}
