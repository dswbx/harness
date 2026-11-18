import { type DropPoint, onFileDrop } from "@harness/api";
import { inside } from "./attachments";

type Rect = { left: number; top: number; right: number; bottom: number };

/** A prompt box that can take files dropped on the window. */
export type DropTarget = {
   el: () => HTMLElement | null;
   /** The area that belongs to this box (the chat column, a Side chat panel body). */
   region: () => HTMLElement | null;
   /** The box of the Main Thread: it takes drops that are over no box or region. */
   main: boolean;
   /** The drag is over the window and this target would take the drop. */
   over: (on: boolean) => void;
   drop: (paths: string[]) => void;
};

export type TargetRects = { box: Rect | null; region: Rect | null; main: boolean };

const area = (r: Rect) => (r.right - r.left) * (r.bottom - r.top);

/**
 * Which target takes a drop at `point`: the box under the point, else the box of the smallest
 * region under it, else the Main Thread's box (else the first). Focus plays no role. -1: no target.
 */
export function pickTarget(targets: TargetRects[], point: DropPoint | undefined): number {
   if (point) {
      const under = targets.findIndex((t) => t.box !== null && inside(t.box, point));
      if (under >= 0) return under;
      let best = -1;
      let bestArea = Number.POSITIVE_INFINITY;
      targets.forEach((t, i) => {
         if (!t.region || !inside(t.region, point) || area(t.region) >= bestArea) return;
         best = i;
         bestArea = area(t.region);
      });
      if (best >= 0) return best;
   }
   const main = targets.findIndex((t) => t.main);
   if (main >= 0) return main;
   return targets.length ? 0 : -1;
}

/** An element other than a prompt box that takes files dropped on it (a task, the Session note). */
export type DropZone = {
   el: () => HTMLElement | null;
   /** The drag is over this zone. */
   over: (on: boolean) => void;
   drop: (paths: string[]) => void;
};

/**
 * Which zone takes a drop on `hit` (the element under the pointer): the innermost zone that holds it. -1: none,
 * then a prompt box takes it.
 */
export function pickZone(zones: (HTMLElement | null)[], hit: Element | null): number {
   let best = -1;
   zones.forEach((el, i) => {
      if (!el || !hit || !el.contains(hit)) return;
      const cur = best >= 0 ? zones[best] : null;
      if (!cur || cur.contains(el)) best = i;
   });
   return best;
}

const targets: DropTarget[] = [];
const zones: DropZone[] = [];
let stop: (() => void) | null = null;
/** Bumped on every subscribe and unsubscribe, so a late `onFileDrop` answer knows it is stale. */
let run = 0;

function chosen(point: DropPoint | undefined): DropTarget | undefined {
   const rects = targets.map((t) => ({
      box: t.el()?.getBoundingClientRect() ?? null,
      region: t.region()?.getBoundingClientRect() ?? null,
      main: t.main,
   }));
   return targets[pickTarget(rects, point)];
}

/** The zone under `point`. Hit-tested, so a zone covered by something else (a popover, a preview) is not taken. */
function zoneAt(point: DropPoint | undefined): DropZone | undefined {
   if (!point || !zones.length) return undefined;
   const hit = document.elementFromPoint?.(point.x, point.y) ?? null;
   return zones[
      pickZone(
         zones.map((z) => z.el()),
         hit,
      )
   ];
}

/** One window listener serves every target and zone: on while there is at least one. */
function listen<T>(list: T[], item: T): () => void {
   list.push(item);
   if (targets.length + zones.length === 1) {
      const mine = ++run;
      void onFileDrop((e) => {
         const point = e.type === "leave" ? undefined : e.position;
         const zone = e.type === "leave" ? undefined : zoneAt(point);
         const to = e.type === "leave" || zone ? undefined : chosen(point);
         const over = e.type === "over";
         for (const z of zones) z.over(over && z === zone);
         for (const t of targets) t.over(over && t === to);
         if (e.type === "drop") (zone ?? to)?.drop(e.paths);
      }).then((u) => {
         if (mine === run) stop = u;
         else u?.();
      });
   }
   return () => {
      const i = list.indexOf(item);
      if (i >= 0) list.splice(i, 1);
      if (targets.length + zones.length === 0) {
         run++;
         stop?.();
         stop = null;
      }
   };
}

/**
 * Registers a prompt box for file drops (Tauri delivers them to the window, not to an element).
 * Returns the unregister function.
 */
export const registerDropTarget = (target: DropTarget): (() => void) => listen(targets, target);

/** Registers a drop zone: a drop over it goes to it, not to a prompt box. Returns the unregister function. */
export const registerDropZone = (zone: DropZone): (() => void) => listen(zones, zone);
